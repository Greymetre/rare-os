import type { PoolClient } from 'pg';
export function schedulingOverview(db: PoolClient, siteId: string): Promise<any>;
export function materialsOverview(db: PoolClient, siteId: string): Promise<any>;
