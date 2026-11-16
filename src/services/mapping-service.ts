import { DirectoryPerson, CustomerDetails } from '../domain';

export interface IMappingService {
  normalizeEmail(email: string | null | undefined): string | null;
  mapDirectoryPersonToCustomerDetails(person: DirectoryPerson): CustomerDetails | null;
}

export class MappingService implements IMappingService {
  /**
   * Normalizes an email address:
   * - Trims surrounding whitespace
   * - Converts to lowercase
   * - Returns null if the email is missing, empty, or does not contain an '@'
   */
  normalizeEmail(email: string | null | undefined): string | null {
    if (!email) {
      return null;
    }
    const trimmed = email.trim();
    if (trimmed === '' || !trimmed.includes('@')) {
      return null;
    }
    return trimmed.toLowerCase();
  }

  /**
   * Maps a vendor-neutral DirectoryPerson into a candidate CustomerDetails object.
   * If the person has no usable email address, returns null.
   */
  mapDirectoryPersonToCustomerDetails(person: DirectoryPerson): CustomerDetails | null {
    const normalizedEmail = this.normalizeEmail(person.email);
    if (!normalizedEmail) {
      return null;
    }

    const cleanString = (val: string | null | undefined): string | null => {
      if (!val) return null;
      const trimmed = val.trim();
      return trimmed === '' ? null : trimmed;
    };

    return {
      email: normalizedEmail,
      emailAddress: normalizedEmail,
      title: cleanString(person.jobTitle),
      officePhoneNumber: cleanString(person.officePhone),
      supervisor: cleanString(person.supervisorName),
      officeClassroom: cleanString(person.officeLocation),
    };
  }
}
