export { defineModel, modelRegistry, type Model } from './data/model.js'
export { field, inc, dec, type Infer } from './data/fields.js'
export { Paginator, type Page } from './data/paginator.js'
export {
  F, Q, Value, Case, When, Coalesce, Lower, Upper, Length, Abs, Cast, TruncDay, TruncMonth, TruncYear,
  Sum, Count, Avg, Min, Max, Exists, OuterRef, Subquery, Prefetch, CheckConstraint, UniqueConstraint,
} from './data/expressions.js'
export { atomic, defer, onCommit, setOnCommitErrorHandler } from './data/engine.js'
export { configureDb, closeDb } from './data/db.js'
export { makeMigrations, migrate, migrateCheck } from './data/migrate.js'
export { defineAction, ActionManifest, paramSpecs, DomainError } from './core/actions.js'
export { discover } from './views/discover.js'
export {
  View, GenericView, ListView, DetailView, CreateView, UpdateView, DeleteView, ListCreateView,
  RetrieveUpdateView, RetrieveDestroyView, RetrieveUpdateDestroyView, ModelViewSet, action, defineSerializer,
  type Serializer, type ViewCtx, type GeneratedAction,
} from './views/generic.js'
export { ANONYMOUS } from './core/types.js'
export type {
  Sid, Rev, NodeId, ActionId, Node, ActionRef, Link, Snapshot, Command, Event, ErrCode, FieldError, ChannelLayer,
  ReadonlyHeaders, TvineUser, UploadedFile, Request, Session, ActionCtx, PermissionCtx, Permission,
  Middleware, ActionDef, ActionRules, Settings, Paginated, AuthSettings, PasswordHasher, PasswordValidator,
} from './core/types.js'
export { defineSettings, settings, type SettingsInput } from './settings.js'
export { defineUpload, DiskStorage, media, type Storage, type UploadDef, type UploadOpts } from './media/index.js'
export { allowAny, denyAgents, deniesAgents, isAuthenticated, isStaff, isSuperuser, hasPerm, modelPermissions, permCodename, allOf, anyOf, loginRequired, permissionRequired, userPassesTest, staffMemberRequired } from './security/permissions.js'
export { authenticate, authBackend, cycleSession, setAuthBackend, type AuthBackend } from './core/auth.js'
export {
  createAgentServer, currentRequest, currentSession, formDispatcher, loadSettings, type PageAccess, type AgentServer, type AgentServerOptions, type HeadersLike, type CookieJar,
  type FormSource, type NextApp, type NextFactory,
} from './server.js'
export { discoverMiddleware, Hooks, type HookEvents, type HookName } from './core/middleware.js'
export { guardCheck } from './transport/guards.js'
export { dispatch, collect, serverCtx, formResult, renderCtx, type ServerCtx, type FormResult, type Log } from './core/dispatch.js'
export { httpTransport, isAgent, type HttpOptions } from './transport/http.js'
export { apiTransport, invoke, signForward, verifyForward, toApiResult, API_PREFIX, FORWARD, type ApiResult, type ApiCall, type Forward } from './transport/api.js'
export type { McpOptions } from './transport/mcp.js'
// lazy: importing 'tvine' never loads the MCP SDK; it loads on the first call (mcpServer/mcpTools: transport/mcp.ts)
export function mcpHandler(...a: Parameters<typeof import('./transport/mcp.js').mcpHandler>): ReturnType<typeof import('./transport/mcp.js').mcpHandler> {
  const h = import('./transport/mcp.js').then((m) => m.mcpHandler(...a))
  h.catch(() => undefined)   // surfaced by the first call
  return async (req, res) => (await h)(req, res)
}
export { discoveryTransport, buildSiteManifest, loadNextRoutes, type RouteInfo, type SiteManifest } from './transport/discovery.js'
export { channelTransport, type ChannelDeps } from './transport/channel.js'
export { TabHub, tabTransport, TAB_LIMITS, type TabAnswer, type AgentState } from './transport/tab.js'
export { routeMatcher } from './transport/routes.js'
export { getRedis, getSubscriber, redisKey, configureRedis, closeRedis, redis, RedisConnections, type RedisClient } from './redis/index.js'
export { path, re_path, include, reverse, SimpleRouter, DefaultRouter, NoReverseMatch, ImproperlyConfigured, type UrlEntry, type UrlTable } from './urls.js'
export { cache, caches, Cache, configureCaches, type Store } from './cache/index.js'
export {
  sendMail, sendMassMail, sendMessages, mailAdmins, mail, configureMail, EmailMessage, EmailMultiAlternatives, BadHeaderError,
  type SendMailOpts, type Attachment, type MailPending,
} from './mail/index.js'
export { SmtpError } from './mail/smtp.js'
export { metrics } from './core/metrics.js'   // BACKLOG #9: apps may add counters/gauges to the same /tvine/metrics
export { defineMiddleware, CATALOG as MIDDLEWARE_CATALOG, type HttpMiddleware, type MwRequest, type RequestState, type BuildCtx, type MiddlewareEntry } from './middleware/index.js'
export { getLogger, configureLogging, type Logger, type LogRecord, type LogHandler, type LoggingConfig, type LoggingSetting, type Level } from './log.js'
export { env, loadDotenv, loadEnv, FRAMEWORK_ENV } from './env.js'
export { securityEvent } from './core/audit.js'
export { signing, dumps, loads, Signer, TimestampSigner, BadSignature, SignatureExpired, configureSigning } from './security/signing.js'
export { safeFetch, isPrivateAddress, SafeFetchError, type SafeFetchOpts } from './security/safe-fetch.js'
