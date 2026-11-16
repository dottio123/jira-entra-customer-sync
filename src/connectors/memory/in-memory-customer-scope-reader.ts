/**
 * In-Memory Customer Scope Reader (Test Double).
 *
 * ARCHITECTURAL PRINCIPLE:
 * In-memory adapters provide deterministic, dependency-free implementations of domain ports
 * for unit and integration testing without requiring external network dependencies.
 */

import { ExistingCustomerReference, ExistingCustomerScopeReaderPort } from '../../domain';

export class InMemoryCustomerScopeReader implements ExistingCustomerScopeReaderPort {
  private customers: ExistingCustomerReference[];

  constructor(customers: ExistingCustomerReference[] = []) {
    this.customers = [...customers];
  }

  setCustomers(customers: ExistingCustomerReference[]): void {
    this.customers = [...customers];
  }

  async *listExistingCustomers(): AsyncIterable<ExistingCustomerReference> {
    for (const customer of this.customers) {
      yield { ...customer };
    }
  }
}
