import { DirectoryPerson, DirectorySourcePort } from '../../domain';

/**
 * In-memory adapter implementing DirectorySourcePort for testing and offline execution.
 */
export class InMemoryDirectorySource implements DirectorySourcePort {
  private people: DirectoryPerson[] = [];

  constructor(initialPeople: DirectoryPerson[] = []) {
    this.people = initialPeople.map((p) => ({ ...p }));
  }

  async getPeople(): Promise<DirectoryPerson[]> {
    return this.people.map((p) => ({ ...p }));
  }

  setPeople(people: DirectoryPerson[]): void {
    this.people = people.map((p) => ({ ...p }));
  }

  addPerson(person: DirectoryPerson): void {
    this.people.push({ ...person });
  }

  clear(): void {
    this.people = [];
  }
}
