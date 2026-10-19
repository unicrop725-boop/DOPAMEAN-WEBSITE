import { describe, expect, it } from 'vitest';
import { addressInput } from '@/modules/customers/domain/address';
import { GST_STATES, isGstStateCode, stateName } from '@/modules/customers/domain/states';

const valid = {
  fullName: 'Asha Verma',
  line1: '12 Test Street',
  city: 'Panipat',
  stateCode: '06',
  pincode: '132103',
  phone: '9876543210',
};

describe('address validation', () => {
  it('accepts a valid Indian address and defaults isDefault to false', () => {
    const a = addressInput.parse(valid);
    expect(a).toMatchObject({ pincode: '132103', phone: '9876543210', isDefault: false });
    expect(a.line2).toBeUndefined();
  });

  it('normalises phone numbers with +91, 91, 0 prefixes, spaces and dashes', () => {
    for (const p of ['+91 98765 43210', '919876543210', '09876543210', '98765-43210']) {
      expect(addressInput.parse({ ...valid, phone: p }).phone, p).toBe('9876543210');
    }
  });

  it('rejects bad phone numbers, pincodes and states', () => {
    expect(() => addressInput.parse({ ...valid, phone: '12345' })).toThrow();
    expect(() => addressInput.parse({ ...valid, phone: '5876543210' })).toThrow();
    expect(() => addressInput.parse({ ...valid, pincode: '012345' })).toThrow();
    expect(() => addressInput.parse({ ...valid, pincode: '12345' })).toThrow();
    expect(() => addressInput.parse({ ...valid, stateCode: '99' })).toThrow();
  });

  it('trims text and rejects empty required fields', () => {
    expect(addressInput.parse({ ...valid, city: '  Panipat  ' }).city).toBe('Panipat');
    expect(() => addressInput.parse({ ...valid, fullName: ' ' })).toThrow();
  });
});

describe('GST state codes', () => {
  it('knows Haryana is 06 and rejects unknown codes', () => {
    expect(stateName('06')).toBe('Haryana');
    expect(isGstStateCode('27')).toBe(true);
    expect(isGstStateCode('00')).toBe(false);
    expect(isGstStateCode('25')).toBe(false); // old Daman and Diu code, merged into 26
  });

  it('has unique codes', () => {
    const codes = GST_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
