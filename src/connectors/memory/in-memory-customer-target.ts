import { CustomerDetails, CustomerFieldUpdates, CustomerDetailsTargetPort } from '../../domain';

export interface TargetUpdateCall {
  email: string;
  updates: CustomerFieldUpdates;
  timestamp: string;
}

/**
 * In-memory adapter implementing CustomerDetailsTargetPort for testing and offline execution.
 */
export class InMemoryCustomerTarget implements CustomerDetailsTargetPort {
  private customers: Map<string, CustomerDetails> = new Map();
  private updateCalls: TargetUpdateCall[] = [];

  constructor(initialCustomers: CustomerDetails[] = []) {
    for (const customer of initialCustomers) {
      const key = this.normalize(customer.email);
      this.customers.set(key, { ...customer, email: key });
    }
  }

  private normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  async findByEmail(normalizedEmail: string): Promise<CustomerDetails | null> {
    const key = this.normalize(normalizedEmail);
    const found = this.customers.get(key);
    return found ? { ...found } : null;
  }

  async updateCustomerDetails(
    normalizedEmail: string,
    updates: CustomerFieldUpdates,
  ): Promise<void> {
    const key = this.normalize(normalizedEmail);
    const existing = this.customers.get(key);
    if (!existing) {
      throw new Error(`Customer with email "${normalizedEmail}" not found in target.`);
    }

    this.updateCalls.push({
      email: key,
      updates: { ...updates },
      timestamp: new Date().toISOString(),
    });

    this.customers.set(key, {
      ...existing,
      ...updates,
    });
  }

  // --- Inspection and Helper Methods for Tests & Demos ---

  getUpdateCalls(): TargetUpdateCall[] {
    return this.updateCalls.map((call) => ({
      email: call.email,
      updates: { ...call.updates },
      timestamp: call.timestamp,
    }));
  }

  getUpdateCallCount(): number {
    return this.updateCalls.length;
  }

  getCustomer(email: string): CustomerDetails | undefined {
    const key = this.normalize(email);
    const found = this.customers.get(key);
    return found ? { ...found } : undefined;
  }

  getAllCustomers(): CustomerDetails[] {
    return Array.from(this.customers.values()).map((c) => ({ ...c }));
  }

  setCustomer(customer: CustomerDetails): void {
    const key = this.normalize(customer.email);
    this.customers.set(key, { ...customer, email: key });
  }

  resetUpdateCalls(): void {
    this.updateCalls = [];
  }
}
