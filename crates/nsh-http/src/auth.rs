//! The auth seam: a token provider the client asks for every request, with
//! single-flight refresh on 401 — ten parallel requests with an expired token
//! cause exactly one refresh and all replay (behavior row 7).

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::Waker;

use crate::middleware::BoxFuture;

/// Supplies the bearer token and refreshes it when the server answers 401.
/// Called on the engine's executor: return boxed futures, never block.
pub trait TokenProvider: Send + Sync + 'static {
    /// The token to send now (`Authorization: Bearer <token>`).
    fn token(&self) -> BoxFuture<Result<String, String>>;
    /// A fresh token to replace `expired`. All requests waiting on this call
    /// share one refresh; a failure fails them all.
    fn refresh(&self, expired: &str) -> BoxFuture<Result<String, String>>;
}

/// Who a [`SingleFlight::begin`] caller is: the one that refreshes (holding
/// the flight's [`LeadGuard`]), or one that waits for the refresh already
/// running.
pub(crate) enum Flight<'a> {
    /// Call `TokenProvider::refresh`, then [`LeadGuard::finish`]. If the
    /// guard drops without finishing (the task died mid-refresh), the
    /// followers are woken to claim the flight again.
    Lead(LeadGuard<'a>),
    /// Await [`SingleFlight::wait`] for the lead's outcome.
    Follow,
}

/// What a follower's [`SingleFlight::wait`] resolves with.
pub(crate) enum Waited {
    /// The lead published this outcome.
    Result(Result<String, String>),
    /// The lead's task died before publishing anything: claim the flight
    /// again (via [`SingleFlight::begin`]) — as lead, or behind whoever
    /// claimed first.
    Abandoned,
}

struct FlightState {
    /// A refresh is out and nobody has published its result.
    running: bool,
    /// Which claimed flight this slot describes: a stale guard's drop must
    /// not release a newer lead's flight.
    generation: u64,
    result: Option<Result<String, String>>,
    wakers: Vec<Waker>,
}

/// One refresh at a time: the first 401 leads, the rest follow the same
/// result. The slot survives until the next cycle's lead clears it, so a
/// follower polling just after the lead finished still reads the result.
///
/// Abandon semantics: the lead holds a [`LeadGuard`]; if its task is dropped
/// or cancelled before `finish`, the guard's `Drop` resets the flight and
/// wakes every follower with [`Waited::Abandoned`], and one of them claims
/// the flight anew. Each abandon round moves exactly one waiter into the
/// lead's seat, so recovery terminates with no polling and no timers.
#[derive(Default)]
pub(crate) struct SingleFlight {
    state: Mutex<Option<FlightState>>,
    next_generation: AtomicU64,
}

impl SingleFlight {
    /// Claims the refresh ([`Flight::Lead`], with its guard) or joins one
    /// running ([`Flight::Follow`]).
    pub fn begin(&self) -> Flight<'_> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(state.as_ref(), Some(slot) if slot.running) {
            return Flight::Follow;
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        *state = Some(FlightState {
            running: true,
            generation,
            result: None,
            wakers: Vec::new(),
        });
        Flight::Lead(LeadGuard {
            flight: self,
            generation,
            finished: false,
        })
    }

    /// Resolves with the lead's outcome ([`Waited::Result`]); polls before it
    /// lands stay pending, woken by the lead's finish or its guard's drop.
    pub fn wait(&self) -> Waiter<'_> {
        Waiter { flight: self }
    }
}

/// Marks the caller of [`SingleFlight::begin`] as the flight's lead. Finish
/// it with the refresh's outcome; dropping it unfinished releases the
/// followers ([`Waited::Abandoned`]).
pub(crate) struct LeadGuard<'a> {
    flight: &'a SingleFlight,
    generation: u64,
    finished: bool,
}

impl LeadGuard<'_> {
    /// Publishes the refresh's outcome and wakes the followers.
    pub fn finish(mut self, result: Result<String, String>) {
        self.finished = true;
        let mut state = self
            .flight
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = state.as_mut()
            && slot.generation == self.generation
        {
            slot.running = false;
            slot.result = Some(result);
            for waker in slot.wakers.drain(..) {
                waker.wake();
            }
        }
    }
}

impl Drop for LeadGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut state = self
            .flight
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only the flight this guard claimed: a finished one keeps its
        // published result, a newer lead's flight stays running.
        if let Some(slot) = state.as_mut()
            && slot.generation == self.generation
            && slot.running
        {
            slot.running = false;
            for waker in slot.wakers.drain(..) {
                waker.wake();
            }
        }
    }
}

/// The future [`SingleFlight::wait`] hands out.
pub(crate) struct Waiter<'a> {
    flight: &'a SingleFlight,
}

impl Future for Waiter<'_> {
    type Output = Waited;

    fn poll(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        use std::task::Poll;
        let mut state = self
            .flight
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.as_mut() {
            Some(slot) => {
                if let Some(result) = slot.result.clone() {
                    return Poll::Ready(Waited::Result(result));
                }
                // Leaderless: the lead abandoned; the caller claims the flight.
                if !slot.running {
                    return Poll::Ready(Waited::Abandoned);
                }
                slot.wakers.push(cx.waker().clone());
                Poll::Pending
            }
            // No flight at all: nothing to wait for, claim one.
            None => Poll::Ready(Waited::Abandoned),
        }
    }
}
