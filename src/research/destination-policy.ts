export interface ResearchDestination {
  readonly origin: string;
  readonly pathPrefix: string;
}

export function researchDestinationAllows(destination: ResearchDestination, candidate: URL): boolean {
  if (candidate.protocol !== "https:" || candidate.origin !== destination.origin) return false;
  return candidate.pathname === destination.pathPrefix ||
    (destination.pathPrefix.endsWith("/") && candidate.pathname.startsWith(destination.pathPrefix));
}
