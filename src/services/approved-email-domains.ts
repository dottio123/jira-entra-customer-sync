/** Exact DNS domains only; no wildcard, suffix, URL, or mailbox matching. */
export function parseApprovedEmailDomains(input: string): string[] {
  const domains = [
    ...new Set(
      input
        .trim()
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter(Boolean),
    ),
  ].sort();
  if (
    domains.length > 100 ||
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain.includes('.') ||
        domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    )
  ) {
    throw new Error('Enter up to 100 valid email domains, without @, wildcards, or URLs.');
  }
  return domains;
}

export function isApprovedEmail(email: string, domains: readonly string[]): boolean {
  const parts = email.trim().toLowerCase().split('@');
  return parts.length === 2 && !!parts[0] && !/\s/.test(parts[0]) && domains.includes(parts[1]!);
}
