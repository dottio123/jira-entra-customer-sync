import { describe, it, expect, beforeEach } from 'vitest';
import { SyncService } from '../src/services/sync-service';
import { MappingService } from '../src/services/mapping-service';
import { DiffPlanner } from '../src/services/diff-planner';
import { InMemoryDirectorySource } from '../src/connectors/memory/in-memory-directory-source';
import { InMemoryCustomerTarget } from '../src/connectors/memory/in-memory-customer-target';
import { DirectoryPerson, CustomerDetails } from '../src/domain';
import { Logger } from '../src/utils/logger';

describe('Customer Synchronization Suite', () => {
  let directorySource: InMemoryDirectorySource;
  let customerTarget: InMemoryCustomerTarget;
  let syncService: SyncService;
  // Silent logger for clean test runs
  const testLogger = new Logger('test-sync', 'error');

  beforeEach(() => {
    directorySource = new InMemoryDirectorySource();
    customerTarget = new InMemoryCustomerTarget();
    syncService = new SyncService(
      directorySource,
      customerTarget,
      new MappingService(),
      new DiffPlanner(),
      testLogger,
    );
  });

  it('empty Jira fields populated from directory data', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-001',
      displayName: 'Alice Johnson',
      email: 'alice.johnson@example.com',
      jobTitle: 'Network Administrator',
      officePhone: '+1-555-0101',
      supervisorName: 'Bob Vance',
      officeLocation: 'HQ - 3rd Floor',
    };

    const existingCustomer: CustomerDetails = {
      email: 'alice.johnson@example.com',
      title: null,
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.totalProcessed).toBe(1);
    expect(summary.updatedCount).toBe(1);
    expect(summary.unchangedCount).toBe(0);

    const updated = customerTarget.getCustomer('alice.johnson@example.com');
    expect(updated).toEqual({
      email: 'alice.johnson@example.com',
      emailAddress: 'alice.johnson@example.com',
      title: 'Network Administrator',
      officePhoneNumber: '+1-555-0101',
      supervisor: 'Bob Vance',
      officeClassroom: 'HQ - 3rd Floor',
    });
  });

  it('unchanged values produce no update', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-002',
      displayName: 'Bob Smith',
      email: 'bob.smith@example.com',
      jobTitle: 'DevOps Engineer',
      officePhone: '+1-555-0102',
      supervisorName: 'Alice Johnson',
      officeLocation: 'Suite 200',
    };

    const existingCustomer: CustomerDetails = {
      email: 'bob.smith@example.com',
      title: 'DevOps Engineer',
      officePhoneNumber: '+1-555-0102',
      supervisor: 'Alice Johnson',
      officeClassroom: 'Suite 200',
      emailAddress: 'bob.smith@example.com',
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.totalProcessed).toBe(1);
    expect(summary.updatedCount).toBe(0);
    expect(summary.unchangedCount).toBe(1);
    expect(customerTarget.getUpdateCallCount()).toBe(0);
  });

  it('email matching is case-insensitive', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-003',
      displayName: 'Charlie Davis',
      email: 'CHARLIE.DAVIS@EXAMPLE.COM', // UPPERCASE in directory
      jobTitle: 'Lead Architect',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
    };

    const existingCustomer: CustomerDetails = {
      email: 'charlie.davis@example.com', // lowercase in Jira
      title: 'Architect',
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.updatedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    const updated = customerTarget.getCustomer('charlie.davis@example.com');
    expect(updated?.title).toBe('Lead Architect');
  });

  it('surrounding email whitespace is ignored', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-004',
      displayName: 'Diana Prince',
      email: '   diana.prince@example.com   ', // Whitespace padding in directory
      jobTitle: 'Chief Security Officer',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
    };

    const existingCustomer: CustomerDetails = {
      email: 'diana.prince@example.com',
      title: 'Security Lead',
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.updatedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    const updated = customerTarget.getCustomer('diana.prince@example.com');
    expect(updated?.title).toBe('Chief Security Officer');
  });

  it('empty source values do not erase populated Jira values', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-005',
      displayName: 'Edward Nygma',
      email: 'edward@example.com',
      jobTitle: null, // empty in source
      officePhone: '', // empty in source
      supervisorName: '   ', // whitespace in source
      officeLocation: 'Main Lab 1', // populated in source
    };

    const existingCustomer: CustomerDetails = {
      email: 'edward@example.com',
      title: 'Senior Enigma Specialist', // must not be erased
      officePhoneNumber: '+1-555-0999', // must not be erased
      supervisor: 'Mayor Cobblepot', // must not be erased
      officeClassroom: 'Old Shed', // should be updated
      emailAddress: 'edward@example.com',
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.updatedCount).toBe(1);
    const updated = customerTarget.getCustomer('edward@example.com');
    // Only officeClassroom should be updated; existing values must remain intact
    expect(updated).toEqual({
      email: 'edward@example.com',
      emailAddress: 'edward@example.com',
      title: 'Senior Enigma Specialist',
      officePhoneNumber: '+1-555-0999',
      supervisor: 'Mayor Cobblepot',
      officeClassroom: 'Main Lab 1',
    });
  });

  it('missing email causes the record to be skipped', async () => {
    const personMissingEmail: DirectoryPerson = {
      sourceId: 'entra-006',
      displayName: 'Anonymous User',
      email: null,
      jobTitle: 'Consultant',
    };

    const personEmptyEmail: DirectoryPerson = {
      sourceId: 'entra-007',
      displayName: 'Blank User',
      email: '   ',
      jobTitle: 'Contractor',
    };

    directorySource.addPerson(personMissingEmail);
    directorySource.addPerson(personEmptyEmail);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.totalProcessed).toBe(2);
    expect(summary.skippedCount).toBe(2);
    expect(summary.updatedCount).toBe(0);
    expect(customerTarget.getUpdateCallCount()).toBe(0);
  });

  it('dry-run never writes', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-008',
      displayName: 'Frank Castle',
      email: 'frank.castle@example.com',
      jobTitle: 'Special Investigator',
      officePhone: '+1-555-9000',
    };

    const existingCustomer: CustomerDetails = {
      email: 'frank.castle@example.com',
      title: 'Investigator',
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
      emailAddress: 'frank.castle@example.com',
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: true });

    // Dry-run should report the proposed update count
    expect(summary.isDryRun).toBe(true);
    expect(summary.updatedCount).toBe(1);
    expect(summary.actions).toHaveLength(1);
    expect(summary.actions[0]?.operation).toBe('UPDATE');
    expect(summary.actions[0]?.appliedUpdates).toEqual({
      title: 'Special Investigator',
      officePhoneNumber: '+1-555-9000',
    });

    // PROOF: Target update was NEVER called and in-memory customer was NOT changed
    expect(customerTarget.getUpdateCallCount()).toBe(0);
    const untouchedCustomer = customerTarget.getCustomer('frank.castle@example.com');
    expect(untouchedCustomer?.title).toBe('Investigator');
    expect(untouchedCustomer?.officePhoneNumber).toBeNull();
  });

  it('write mode applies only changed values', async () => {
    const person: DirectoryPerson = {
      sourceId: 'entra-009',
      displayName: 'Grace Hopper',
      email: 'grace.hopper@example.com',
      jobTitle: 'Rear Admiral', // changed
      officePhone: '+1-555-1944', // unchanged
      supervisorName: 'Navy Command', // unchanged
      officeLocation: 'Room B-1', // changed
    };

    const existingCustomer: CustomerDetails = {
      email: 'grace.hopper@example.com',
      title: 'Commander',
      officePhoneNumber: '+1-555-1944',
      supervisor: 'Navy Command',
      officeClassroom: 'Room A-1',
      emailAddress: 'grace.hopper@example.com',
    };

    directorySource.addPerson(person);
    customerTarget.setCustomer(existingCustomer);

    const summary = await syncService.executeSync({ dryRun: false });

    expect(summary.updatedCount).toBe(1);
    expect(customerTarget.getUpdateCallCount()).toBe(1);

    // Verify only changed fields are present in the update call payload
    const updateCall = customerTarget.getUpdateCalls()[0];
    expect(updateCall).toBeDefined();
    expect(updateCall?.updates).toEqual({
      title: 'Rear Admiral',
      officeClassroom: 'Room B-1',
    });
    expect(updateCall?.updates).not.toHaveProperty('officePhoneNumber');
    expect(updateCall?.updates).not.toHaveProperty('supervisor');

    // Verify final state in target
    const finalCustomer = customerTarget.getCustomer('grace.hopper@example.com');
    expect(finalCustomer).toEqual({
      email: 'grace.hopper@example.com',
      emailAddress: 'grace.hopper@example.com',
      title: 'Rear Admiral',
      officePhoneNumber: '+1-555-1944',
      supervisor: 'Navy Command',
      officeClassroom: 'Room B-1',
    });
  });
});
