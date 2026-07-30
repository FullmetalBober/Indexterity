// Change-window policy: elective index changes (hide, build, drop) run only
// inside the configured UTC hour window. Safety responses (unhide, regression
// rollback) are never deferred — they run whenever the engine notices.
//
// Null bounds or start === end mean "no window" (always allowed); start > end
// wraps midnight (22 -> 4 = ten pm to four am).
export function inChangeWindow(
  now: Date,
  startHour: number | null,
  endHour: number | null,
): boolean {
  if (startHour === null || endHour === null || startHour === endHour) return true;
  const hour = now.getUTCHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}
