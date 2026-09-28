type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
export function countRows(db: Db, from: string, where: string, params: unknown[]): Promise<number>;
export const PAGE_SIZES: number[];
export const DEFAULT_PAGE_SIZE: number;
export function pageSize(value: unknown): number | null;
