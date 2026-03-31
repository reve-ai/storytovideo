/**
 * Build a media URL for a run, encoding each path segment so that
 * characters like `/` inside asset names don't break the route.
 */
export function mediaUrl(runId: string, filePath: string): string {
  const encoded = filePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `/api/runs/${runId}/media/${encoded}`;
}
