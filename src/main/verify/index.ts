/**
 * Email verification: free local prefilter, pattern inference, paid providers.
 *
 * The intended call order is always cheapest-first — `prefilter()` costs
 * nothing and removes malformed, disposable, role and dead-domain addresses;
 * `inferPattern()`/`generateCandidates()` turn one confirmed address into N
 * candidates; only what survives both reaches `verifyEmails()`, which is the
 * only function here that can spend money.
 */

export {
  clearMxMemoryCache,
  canonicalizeForCache,
  classifyMxProvider,
  domainOf,
  getCatchAllFlag,
  isDisposableDomain,
  isFreemailDomain,
  isRoleAccount,
  isValidSyntax,
  localPartOf,
  lookupDomainMx,
  normalizeEmail,
  prefilter,
  resolveDomainMx,
  saveCatchAllFlag,
  saveMxProvider,
  verdictReliability,
  type DomainMxInfo,
  type MxProvider,
  type PrefilterResult,
} from './mx.js';

export {
  ALL_PATTERNS,
  buildEmail,
  detectPatterns,
  generateCandidates,
  globalPatternOrder,
  inferPattern,
  loadPattern,
  measuredPatternAccuracy,
  needsLastName,
  normalizeLastName,
  normalizeNamePart,
  patternConformance,
  refreshPattern,
  renderPattern,
  savePattern,
  seedsFromDb,
  splitFullName,
  type Candidate,
  type EmailPattern,
  type InferredPattern,
  type KnownAddress,
  type StoredPattern,
} from './pattern.js';

export {
  COST_MICROS,
  GLOBAL_CAP_PROVIDER,
  ProviderBlockedError,
  SpendCapError,
  assertSpendAvailable,
  estimateVerifyCostUsd,
  loadVerifierConfig,
  outstandingReservedMicros,
  spendSummary,
  syncSpendCap,
  testVerifierKey,
  totalSpentMicros,
  verifyEmail,
  verifyEmails,
  type SpendState,
  type VerifierConfig,
  type VerifierProvider,
  type VerifyOptions,
  type VerifyResult,
} from './verifier.js';
