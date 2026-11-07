import { Input as BaseInput } from "nsh/base";

/** The app's text field: one wrapper over the base input, styled once from tokens. */
export function SearchInput(props: { placeholder: string; value: string; onChange: (value: string) => void; testID?: string }) {
  return (
    <BaseInput
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.value)}
      testID={props.testID}
      accessibilityLabel={props.placeholder}
      class="min-h-10 rounded-(--radius) border border-input bg-background px-3 text-sm text-foreground focus:outline-2 focus:outline-ring"
    />
  );
}
