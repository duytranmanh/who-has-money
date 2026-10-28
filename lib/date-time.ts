// Display timestamps to the minute while leaving stored values and timezone choices intact.
export function formatDateTime(value: string | number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone,
  }).format(new Date(value));
}
