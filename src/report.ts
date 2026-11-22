import type { Badge } from "./profile.js";

// Turning a run into words a person can read on a phone.
//
// Kept free of config and database imports, like comment.ts and feed.ts, so
// `npm run test:proof` can print the exact message that would be sent without
// needing production secrets. notify.ts does the sending; this file only
// decides what it says.

export type RunReport = {
  utcDate: string;
  liked: number;
  likedTitles: string[];
  commented: number;
  commentedTitles: string[];
  skippedAlreadyLiked: number;
  articleSource: string;
  badges: Badge[];
  proof?: Uint8Array;
};

// The streaks the daily run is actually working toward. Listed explicitly
// because the badge page returns 21 badges and a phone notification should
// not contain 21 lines.
const DAILY_STREAKS = /^(7|30|90)-Day (Visit|Like|Comment) Streak$/i;

export function describeRun(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`AWS Builder streak - ${report.utcDate}`);
  lines.push("");

  // What the agent did. Plain verbs, no outcome codes.
  lines.push(report.liked > 0
    ? `Liked ${report.liked} article${report.liked === 1 ? "" : "s"}:`
    : "Liked NOTHING today. The streak needs one like a day, so today did not count.");
  for (const title of report.likedTitles.slice(0, 2)) lines.push(`  - ${title.slice(0, 56)}`);

  lines.push(report.commented > 0
    ? `Commented on ${report.commented} article${report.commented === 1 ? "" : "s"}:`
    : "Posted NO comment today, so the comment streak did not advance.");
  for (const title of report.commentedTitles.slice(0, 2)) lines.push(`  - ${title.slice(0, 56)}`);

  if (report.skippedAlreadyLiked > 0) {
    lines.push(`(Skipped ${report.skippedAlreadyLiked} already liked on earlier days.)`);
  }

  lines.push("");

  // What AWS says. This is the part that is not the agent's own word.
  if (report.badges.length === 0) {
    lines.push("Could NOT read your badge page this time, so the lines above are");
    lines.push("what the agent did, not what AWS has credited.");
    return lines.join("\n");
  }

  const earned = report.badges.filter((badge) => badge.state === "earned");
  lines.push(`AWS badge page: ${earned.length} of ${report.badges.length} badges earned.`);

  const streaks = report.badges.filter((badge) => DAILY_STREAKS.test(badge.name));

  // The real counts first - these come from opening each badge, and they are
  // the only lines that say how many consecutive days AWS has actually
  // credited. Everything else is a status word.
  const withProgress = streaks.filter((badge) => badge.progress);
  if (withProgress.length > 0) {
    lines.push("Your streaks, per AWS:");
    for (const badge of withProgress) {
      lines.push(`  ${badge.name.replace(/ Streak$/, "")}: ${badge.progress}`);
    }
  }

  const earnedStreaks = streaks.filter((badge) => badge.state === "earned");
  const idle = streaks.filter((badge) => badge.state === "not-started");

  if (earnedStreaks.length > 0) {
    lines.push(`Finished: ${earnedStreaks.map((badge) => badge.name).join(", ")}`);
  }
  if (idle.length > 0) {
    // The warning line. A streak badge showing "not started" means the run of
    // consecutive days was broken and is back at zero.
    lines.push(`NOT counting (streak broken): ${idle.map((badge) => badge.name).join(", ")}`);
  }
  if (withProgress.length === 0 && earnedStreaks.length === 0 && idle.length === 0) {
    lines.push(`Streaks counting: ${streaks.filter((badge) => badge.state === "counting").length} of ${streaks.length}.`);
  }

  lines.push("");
  lines.push("Photo above is your live badge page. Blue = earned, grey = not yet.");

  return lines.join("\n");
}
