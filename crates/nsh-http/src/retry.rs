//! Retry policy: backoff with jitter on the app's clock, `Retry-After` (seconds
//! and HTTP-date), idempotent methods only by default, POST never, and never
//! after a body stream started (behavior row 5).

use std::time::Duration;

use crate::error::Error;

/// The HTTP methods whose repetition cannot change server state. `PATCH` and
/// `POST` are absent on purpose.
pub fn is_idempotent(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "PUT" | "DELETE" | "OPTIONS" | "TRACE"
    )
}

/// When to send a request again, and how long to wait between sends.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryPolicy {
    max_retries: u32,
    base_delay_ms: u64,
    max_delay_ms: u64,
    /// Fraction of the computed delay the jitter may add or remove (0.0-1.0).
    jitter: f64,
    /// Retry only [`is_idempotent`] methods (the default).
    idempotent_only: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            base_delay_ms: 250,
            max_delay_ms: 4_000,
            jitter: 0.25,
            idempotent_only: true,
        }
    }
}

impl RetryPolicy {
    /// Up to `max_retries` retries after the first attempt.
    pub fn new(max_retries: u32) -> Self {
        Self {
            max_retries,
            ..Self::default()
        }
    }

    /// Never retries: one attempt, whatever happens.
    pub fn off() -> Self {
        Self {
            max_retries: 0,
            ..Self::default()
        }
    }

    /// The wait before the first retry (`base * 2^(attempt-1)`, capped).
    #[must_use]
    pub fn with_base_delay_ms(mut self, base_delay_ms: u64) -> Self {
        self.base_delay_ms = base_delay_ms;
        self
    }

    /// The longest wait a backoff or a `Retry-After` may ask for.
    #[must_use]
    pub fn with_max_delay_ms(mut self, max_delay_ms: u64) -> Self {
        self.max_delay_ms = max_delay_ms;
        self
    }

    /// The jitter fraction around the backoff delay (`0.5`: ±50%).
    #[must_use]
    pub fn with_jitter(mut self, jitter: f64) -> Self {
        self.jitter = jitter.clamp(0.0, 1.0);
        self
    }

    /// Retries `POST` and other non-idempotent methods too: only for calls
    /// the server treats as safe to repeat.
    #[must_use]
    pub fn for_all_methods(mut self) -> Self {
        self.idempotent_only = false;
        self
    }

    /// How many retries remain after `attempts_done` failed attempts.
    pub fn max_retries(&self) -> u32 {
        self.max_retries
    }

    /// Whether a `(attempt+1)`th send may happen for `error` after
    /// `attempts_done` failed ones. A body stream already started disqualifies
    /// the send: the server may have consumed part of it. The Rust pipeline
    /// never streams a request body (the 0.4.0 transport resolves once, with
    /// the whole response), so it always passes `false`.
    pub fn should_retry(
        &self,
        method: &str,
        error: &Error,
        stream_started: bool,
        attempts_done: u32,
    ) -> bool {
        if attempts_done > self.max_retries
            || stream_started
            || (self.idempotent_only && !is_idempotent(method))
        {
            return false;
        }
        error.is_retryable()
    }

    /// How long to wait before the retry: `Retry-After` when the server said
    /// (capped at the policy's maximum, no jitter), else exponential backoff
    /// with jitter. `noise` is the jitter source, advanced in place; any
    /// changing u64 works (the client uses the clock).
    pub fn delay_ms(
        &self,
        attempts_done: u32,
        retry_after: Option<Duration>,
        noise: &mut u64,
    ) -> u64 {
        if let Some(after) = retry_after {
            return after.as_millis().min(self.max_delay_ms as u128) as u64;
        }
        let shift = attempts_done.saturating_sub(1).min(16);
        let backoff = self
            .base_delay_ms
            .saturating_mul(1_u64 << shift)
            .min(self.max_delay_ms);
        let spread = (backoff as f64 * self.jitter).round() as u64;
        backoff - spread + (next_noise(noise) % (2 * spread + 1))
    }
}

/// A stateful splitmix64 stream: small, dependency-free, good enough for
/// backoff jitter (never for anything secret).
fn next_noise(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_4A95_161E_60AF);
    z ^ (z >> 31)
}

/// The `Retry-After` header's value as a wait: seconds (`120`) or an HTTP-date
/// ([IMF-fixdate](https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1)).
/// A date in the past waits nothing. `now_unix_ms` is the app's wall clock.
pub fn parse_retry_after(value: &str, now_unix_ms: f64) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let at = parse_http_date(value)?;
    let ms = (at - now_unix_ms).max(0.0);
    Some(Duration::from_millis(ms as u64))
}

/// Parses an IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) into Unix
/// milliseconds. Obsolete formats (RFC 850, asctime) parse as `None`.
pub fn parse_http_date(value: &str) -> Option<f64> {
    let rest = value.trim().strip_suffix(" GMT")?;
    // "Sun, 06 Nov 1994 08:49:37" — the weekday name is decorative; the
    // engine reads the rest positionally.
    let rest = rest.split_once(", ")?.1.trim();
    let mut parts = rest.split(' ');
    let day = parts.next()?.parse::<u32>().ok()?;
    let month = month_number(parts.next()?)?;
    let year = parts.next()?.parse::<i64>().ok()?;
    let mut clock = parts.next()?.split(':');
    let (hour, minute, second) = (
        clock.next()?.parse::<u32>().ok()?,
        clock.next()?.parse::<u32>().ok()?,
        clock.next()?.parse::<u32>().ok()?,
    );
    let days = days_from_civil(year, month, day);
    let seconds =
        days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
    Some(seconds as f64 * 1000.0)
}

/// The inverse of [`parse_http_date`], for tests and stubs: an IMF-fixdate
/// for `unix_ms` (truncated toward the second).
pub fn format_http_date(unix_ms: f64) -> String {
    let total_seconds = (unix_ms / 1000.0).floor() as i64;
    let mut days = total_seconds.div_euclid(86_400);
    let mut rest = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = rest / 3_600;
    rest %= 3_600;
    let (minute, second) = (rest / 60, rest % 60);
    const NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // 1970-01-01 was a Thursday (index 3 with Monday as 0).
    days += 3;
    let name = NAMES[days.rem_euclid(7) as usize];
    format!(
        "{name}, {day:02} {} {year:04} {hour:02}:{minute:02}:{second:02} GMT",
        MONTHS[(month - 1) as usize],
    )
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 for a civil date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse: the civil date of a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + i64::from(m <= 2), m as u32, d as u32)
}

fn month_number(name: &str) -> Option<u32> {
    match name {
        "Jan" => Some(1),
        "Feb" => Some(2),
        "Mar" => Some(3),
        "Apr" => Some(4),
        "May" => Some(5),
        "Jun" => Some(6),
        "Jul" => Some(7),
        "Aug" => Some(8),
        "Sep" => Some(9),
        "Oct" => Some(10),
        "Nov" => Some(11),
        "Dec" => Some(12),
        _ => None,
    }
}
