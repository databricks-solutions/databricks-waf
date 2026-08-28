// Carrying one framework requirement into the existing plan/action journey.
//
// The URL carries only the stable catalogue id. The Improvements and Plan pages read the title from
// the catalogue they already loaded, so an edited URL cannot supply customer-facing words or change
// what the eventual action is checked against.

export interface RequirementHandoff {
  readonly controlId: string;
}

export function requirementHref(path: string, controlId: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}control=${encodeURIComponent(controlId)}`;
}

export function requirementIn(params: URLSearchParams): RequirementHandoff | undefined {
  const controlId = params.get('control');
  if (controlId == null || !/^[A-Z]{2,4}-\d{2}-\d{2}$/.test(controlId)) return undefined;
  return { controlId };
}
