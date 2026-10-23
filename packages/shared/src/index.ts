export const PRODUCT_NAME = "VideoNews Studio";

export type ServiceName = "web" | "api" | "worker";

export type HealthStatus = "ok" | "degraded";

export interface ServiceHealth {
  service: ServiceName;
  status: HealthStatus;
  timestamp: string;
}

export function createHealth(service: ServiceName, date: Date = new Date()): ServiceHealth {
  return { service, status: "ok", timestamp: date.toISOString() };
}
