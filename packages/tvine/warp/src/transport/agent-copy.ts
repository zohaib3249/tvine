// Shared agent-facing discovery strings (challenge hint, llms/discovery paths). One place for MCP/llms constants
// and the challenge JSON hint so header/path wording does not drift across Shield and discovery.
export const MCP_PATH = '/mcp'
export const LLMS_PATH = '/llms.txt'
export const MANIFEST_PATH = '/tvine/manifest'
export const DISCOVERY_PATH = '/.well-known/tvine.json'

// Challenge / refusal hint (Shield 403 challenge_required). Paths match discovery + llms.
export function agentHint(): string {
  return `agents: use the MCP endpoint ${MCP_PATH} (no browser checks), an API token (Authorization: Bearer …), or send your agent identity (User-Agent like Claude-User, or Web Bot Auth); people: open the page in a browser`
}
