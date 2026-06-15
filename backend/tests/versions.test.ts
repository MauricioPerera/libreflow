import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { 
  initDatabase, 
  saveWorkflow, 
  deleteWorkflow, 
  getWorkflowById,
  getWorkflowVersions, 
  getWorkflowVersion, 
  restoreWorkflowToVersion 
} from '../src/db.js';

describe('Workflow Versioning & History', () => {
  const testWorkflowId = `flow-test-${Date.now()}`;
  const testWorkflowName = 'Test Versioning Flow';

  beforeAll(async () => {
    await initDatabase();
    // Clean up just in case
    try {
      await deleteWorkflow(testWorkflowId);
    } catch (e) {}
  });

  afterAll(async () => {
    // Clean up database
    try {
      await deleteWorkflow(testWorkflowId);
    } catch (e) {}
  });

  it('should automatically create Version 1 when saving a new workflow', async () => {
    const nodes = [
      { id: 'n1', type: 'trigger', name: 'Start', parameters: {} }
    ];
    const connections = [] as any[];

    // Save the workflow
    await saveWorkflow(testWorkflowId, testWorkflowName, nodes, connections, null);

    // Verify workflow exists
    const workflow = await getWorkflowById(testWorkflowId);
    expect(workflow).toBeDefined();
    expect(workflow.name).toBe(testWorkflowName);

    // Verify version 1 was created
    const versions = await getWorkflowVersions(testWorkflowId);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].name).toBe(testWorkflowName);

    // Verify version 1 content
    const ver1 = await getWorkflowVersion(testWorkflowId, 1);
    expect(ver1).toBeDefined();
    expect(ver1.nodes).toEqual(nodes);
  });

  it('should NOT create a new version if there are no changes on subsequent save', async () => {
    const nodes = [
      { id: 'n1', type: 'trigger', name: 'Start', parameters: {} }
    ];
    const connections = [] as any[];

    // Save exactly the same content
    await saveWorkflow(testWorkflowId, testWorkflowName, nodes, connections, null);

    // Verify that we still have only 1 version
    const versions = await getWorkflowVersions(testWorkflowId);
    expect(versions).toHaveLength(1);
  });

  it('should create Version 2 when saving changes', async () => {
    const nodes = [
      { id: 'n1', type: 'trigger', name: 'Start', parameters: {} },
      { id: 'n2', type: 'set', name: 'SetValue', parameters: { values: [{ key: 'a', value: 1 }] } }
    ];
    const connections = [
      { source: 'n1', target: 'n2' }
    ];

    // Save modified content
    await saveWorkflow(testWorkflowId, testWorkflowName, nodes, connections, null);

    // Verify Version 2 exists and is returned first
    const versions = await getWorkflowVersions(testWorkflowId);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);

    // Verify Version 2 content
    const ver2 = await getWorkflowVersion(testWorkflowId, 2);
    expect(ver2.nodes).toEqual(nodes);
    expect(ver2.connections).toEqual(connections);
  });

  it('should restore a specific version and create a new version for the rollback', async () => {
    // Restore to Version 1
    const restored = await restoreWorkflowToVersion(testWorkflowId, 1);
    expect(restored).toBeDefined();
    expect(restored.version).toBe(1);

    // Verify the main workflow was updated back to Version 1 content (only 1 node)
    const workflow = await getWorkflowById(testWorkflowId);
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.nodes[0].id).toBe('n1');

    // Verify a new version (Version 3) was created representing the restore
    const versions = await getWorkflowVersions(testWorkflowId);
    expect(versions).toHaveLength(3);
    expect(versions[0].version).toBe(3); // Version 3 is the restore action
    
    // Version 3 content should be identical to Version 1 content
    const ver3 = await getWorkflowVersion(testWorkflowId, 3);
    expect(ver3.nodes).toHaveLength(1);
    expect(ver3.nodes[0].id).toBe('n1');
  });
});
