export function stdDev(list: number[]): number;
export function monthShape(weights: number[], monthMinutes: number, capacityPerDay: number): any;
export function levelLoad(weights: number[], monthUnits: number): any;
export function bufferVsMto(item: any, options?: any): any;
export function serviceSimulation(item: any, service?: number): any;
export function serviceCurve(items: any[], services?: number[]): any[];
export function eventCovers(event: any, item: any): boolean;
export function eventFactor(events: any[], item: any, date: string, leadTimeDays?: number): number;
export function eventCurve(item: any, events: any[], options: any): any[];
export function schemeDemand(
  schemes: any[],
  today: string,
  horizonDays: number,
): Map<string, number>;
export function spaceFit(rows: any[], capacity: number): any;
export function targetScenario(items: any[], ratio: number, options?: any): any;
export function constraintStability(resources: any[]): any;
export function machineWhatIf(resources: any[], resourceId: string, machines: number): any;
