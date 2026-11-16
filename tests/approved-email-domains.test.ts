import { describe, expect, it } from 'vitest';
import { parseApprovedEmailDomains, isApprovedEmail } from '../src/services/approved-email-domains';

describe('approved email domains', () => {
  it('normalizes, deduplicates, and sorts multiple domains', () => {
    expect(parseApprovedEmailDomains('EXAMPLE.ORG, example.com\nexample.org; example.net')).toEqual(
      ['example.com', 'example.net', 'example.org'],
    );
    expect(parseApprovedEmailDomains('')).toEqual([]);
    expect(isApprovedEmail(' User@EXAMPLE.COM ', ['example.com'])).toBe(true);
  });
  it.each([
    '*.example.com',
    '@example.com',
    'https://example.com',
    'example..com',
    '-example.com',
    'example.com/path',
  ])('rejects invalid domain %s', (value) => {
    expect(() => parseApprovedEmailDomains(value)).toThrow();
  });
  it.each([
    'a@sub.example.com',
    'a@notexample.com',
    'a@example.com.evil.test',
    'a@@example.com',
    '@example.com',
    'a b@example.com',
  ])('does not permit suffix or malformed matches %s', (email) => {
    expect(isApprovedEmail(email, ['example.com'])).toBe(false);
  });
});
