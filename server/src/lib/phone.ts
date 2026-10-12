import { z } from 'zod';

/**
 * Indian phone numbers. Accepts common ways of writing them ("98765 43210", "+91-98765-43210",
 * "09876543210", "0191 245 0011") and stores one consistent format ("+91 98765 43210").
 * Mobiles are 10 digits starting 6–9; landlines are the STD code + number (10 digits without the 0).
 */
export function parseIndianPhone(raw: string, kind: 'mobile' | 'any'): string | null {
  const digits = raw.replace(/[\s().-]/g, '');
  const match = digits.match(/^(?:\+91|91|0)?([1-9]\d{9})$/);
  if (!match) return null;
  const national = match[1];
  const isMobile = /^[6-9]/.test(national);
  if (kind === 'mobile' && !isMobile) return null;
  return isMobile ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : `+91 ${national}`;
}

const phoneSchema = (kind: 'mobile' | 'any', message: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      const phone = parseIndianPhone(value, kind);
      if (!phone) {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
      return phone;
    });

/** A person's mobile number (patients, doctors). */
export const mobileSchema = phoneSchema('mobile', 'Enter a valid 10-digit Indian mobile number, e.g. 98765 43210');

/** An organization's contact number: mobile, or landline with STD code. */
export const contactPhoneSchema = phoneSchema('any', 'Enter a valid Indian phone number: a 10-digit mobile, or a landline with STD code (e.g. 0191 245 0011)');

/** Organization types that must publish a contact number. */
export const PHONE_REQUIRED_ORG_TYPES = ['LABORATORY', 'DIAGNOSTIC_CENTER'] as const;
export const orgNeedsPhone = (type: string) => (PHONE_REQUIRED_ORG_TYPES as readonly string[]).includes(type);
