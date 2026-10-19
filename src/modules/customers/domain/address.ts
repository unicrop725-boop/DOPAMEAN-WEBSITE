import { z } from 'zod';
import { isGstStateCode } from './states';

/** 10-digit Indian mobile, tolerating +91 / 91 / 0 prefixes, spaces and dashes. Normalised to 10 digits. */
export const indianMobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=[6-9]\d{9}$)/, ''))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

/** Indian address validation. Pure: used by server actions and tests. */
export const addressInput = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(120),
  line1: z.string().trim().min(3, 'Enter the address').max(200),
  line2: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  city: z.string().trim().min(2, 'Enter the city').max(100),
  stateCode: z.string().refine(isGstStateCode, 'Choose a state'),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode'),
  phone: indianMobile,
  isDefault: z.boolean().default(false),
});

export type AddressInput = z.infer<typeof addressInput>;
export type AddressFormInput = z.input<typeof addressInput>;

export const MAX_ADDRESSES_PER_CUSTOMER = 10;
