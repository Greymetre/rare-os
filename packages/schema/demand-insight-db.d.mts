import type { PoolClient } from 'pg';
export function demandInsight(db: PoolClient, siteId: string, today: string): Promise<any>;
export function abcXyz(db: PoolClient, siteId: string, weeks?: number): Promise<any>;
