export interface PtpStatus {
	active: boolean
	kills: number
	lastKillAt: number | null
}
export interface OscStatus {
	state: 'off' | 'open' | 'error'
	wsPort: number
	udpIn: number
	udpOut: number
	error: string | null
	messages: number
	last: {address: string; args: unknown[]; at: number} | null
}
export interface ToolsStatus {
	state: 'off' | 'listening' | 'error'
	host: string
	port: number
	error: string | null
	provider: {project: string | null; origin: string | null; since: number} | null
	tools: number
	calls: number
	lastCall: {name: string; ok: boolean; ms: number; at: number; error: string | null} | null
	sessions: number
}
export interface AuxStatus {
	ptp: PtpStatus
	osc: OscStatus
	tools: ToolsStatus
}
export interface AuxLog {
	t: number
	tag: string
	text: string
	level: 'info' | 'warn' | 'error'
}
export interface Aux {
	status: AuxStatus
	history: AuxLog[]
	on(event: 'log', fn: (entry: AuxLog) => void): () => void
	on(event: 'status', fn: (status: AuxStatus) => void): () => void
	log(tag: string, text: string, level?: AuxLog['level']): void
	stop(): void
}
export const TOOLS_PORT: number
export function createAux(options?: {
	ptp?: {intervalMs?: number}
	osc?: {wsPort?: number; udpIn?: number; udpOut?: number}
	tools?: {port?: number; host?: string; callTimeoutMs?: number}
	version?: string
}): Aux
