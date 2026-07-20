export { OpenCodeReadOnlyProgram } from "./agents/opencode-read-only-program.js";
export type { OpenCodeReadOnlyProgramRequest, OpenCodeReadOnlyProgramResult } from "./agents/opencode-read-only-program.js";
export type { OpenCodeReadOnlyExecutedResult, OpenCodeReadOnlyPausedResult } from "./agents/opencode-read-only-program.js";
export type { OpenCodeReadOnlyAgentResult } from "./agents/opencode-read-only-agent.js";
export { DockerOpenCodeReadOnlyCapsule } from "./capsule/opencode-read-only-capsule.js";
export { DisabledModelBroker } from "./capsule/model-broker.js";
export type { ModelBroker, ModelBrokerRequest, ModelBrokerReceipt } from "./capsule/model-broker.js";
export type { AzureOpenAIProviderConfig } from "./providers/azure-openai-model-broker.js";
export type { InstalledProviderConfig } from "./providers/provider-config.js";
export type {
  AtomicAppend,
  AtomicEventJournal,
  DurablePagedEventJournal,
  EventJournal,
  GlobalEventPage,
  JournalPageLimits,
  PagedEventJournal,
  ProjectionClaim,
  ProjectionCursor,
  StreamEventPage,
} from "./journal/journal.js";
export {
  ATOMIC_EVENT_JOURNAL,
  DURABLE_PAGED_EVENT_JOURNAL,
  createProjectionClaimantId,
  isAtomicEventJournal,
  isDurablePagedEventJournal,
} from "./journal/journal.js";
export { SqliteEventJournal } from "./journal/sqlite-journal.js";
export {
  ArchivedEventJournal,
  JournalRetentionService,
  openAuthoritativeJournal,
} from "./journal/retention.js";
export type {
  ArchiveManifest,
  ArchiveResult,
  PruneRequest,
  RetentionRecovery,
  RetentionReconcileResult,
  VacuumEvidence,
  RetentionPolicy,
} from "./journal/retention.js";
export { ProjectingEventJournal } from "./journal/projecting-journal.js";
export type { StoredEventSink } from "./journal/projecting-journal.js";
export {
  ANALYSIS_SCHEMA_VERSION,
  AnalysisBudgetExhaustedPayloadSchema,
  AnalysisBudgetReservedPayloadSchema,
  AnalysisBudgetChargedPayloadSchema,
  AnalysisBudgetRevisedPayloadSchema,
  AnalysisBudgetSchema,
  AnalysisCancelledPayloadSchema,
  AnalysisCompletedPayloadSchema,
  AnalysisObservedPayloadSchema,
  AnalysisInvocationReservedPayloadSchema,
  AnalysisRevisedPayloadSchema,
  AnalysisReconciliationRequiredPayloadSchema,
  AnalysisRoundResultSchema,
  AnalysisStartedPayloadSchema,
  AnalysisTerminalPayloadSchema,
  AnalysisUncertaintySchema,
  RetainedAnalysisSourceSchema,
  analysisStreamId,
  analysisBudgetStreamId,
} from "./analysis/analysis-contracts.js";
export type {
  AnalysisAdapterRequest,
  AnalysisAnswer,
  AnalysisBudget,
  AnalysisObservation,
  AnalysisRoundResult,
  AnalysisUncertainty,
  RetainedAnalysisSource,
} from "./analysis/analysis-contracts.js";
export { AnalysisCoordinator } from "./analysis/analysis-coordinator.js";
export type {
  AnalysisCoordinatorResult,
} from "./analysis/analysis-coordinator.js";
export { AnalysisExecutionError, CapsuleBackedAnalysisAdapter, createCapsuleBackedAnalysisAdapter } from "./analysis/capsule-analysis-adapter.js";
export type { AnalysisAdapterResult, CapsuleBackedAnalysisAdapterOptions, TrustedAnalysisCapsuleConfig } from "./analysis/capsule-analysis-adapter.js";
export { GitAnalysisRepositorySnapshotProvider } from "./analysis/analysis-repository-snapshot.js";
export type {
  AnalysisRepositorySnapshotProvider,
  AnalysisSnapshotPreparationLimits,
  GitAnalysisRepositorySnapshotProviderOptions,
  PreparedAnalysisSnapshot,
} from "./analysis/analysis-repository-snapshot.js";
export {
  ATTENTION_SCHEMA_VERSION,
  ApprovalAcceptedPayloadSchema,
  ApprovalPacketSchema,
  ApprovalReservationConsumedPayloadSchema,
  ApprovalReservationPayloadSchema,
  ApprovalStalePayloadSchema,
  AttemptPayloadSchema,
  AttentionRaisedPayloadSchema,
  AttentionResolvedPayloadSchema,
  AttentionIndexRaisedPayloadSchema,
  AttentionIndexResolvedPayloadSchema,
  AttentionIdentityReservationPayloadSchema,
  DecisionAcceptedPayloadSchema,
  DecisionActorSchema,
  DecisionExpiredPayloadSchema,
  DecisionOptionSchema,
  DecisionRejectedPayloadSchema,
  DecisionRequestedPayloadSchema,
  ExpiryPolicySchema,
  QuestionPacketSchema,
  ScopeAdmissionPayloadSchema,
  advisoryAttentionStreamId,
  attentionIndexStreamId,
  attentionIdentityReservationStreamId,
  approvalReservationStreamId,
  decisionAttemptStreamId,
  decisionStreamId,
  parseDecisionAttemptStreamId,
} from "./attention/attention-contracts.js";
export type {
  ApprovalAcceptedPayload,
  ApprovalPacket,
  ApprovalReservationConsumedPayload,
  ApprovalReservationPayload,
  ApprovalStalePayload,
  AttemptPayload,
  AttentionRaisedPayload,
  AttentionResolvedPayload,
  AttentionIndexRaisedPayload,
  AttentionIndexResolvedPayload,
  AttentionIdentityReservationPayload,
  DecisionAcceptedPayload,
  DecisionActor,
  DecisionExpiredPayload,
  ExpiryPolicy,
  DecisionOption,
  DecisionRejectedPayload,
  DecisionRequestedPayload,
  QuestionPacket,
  ScopeAdmissionPayload,
} from "./attention/attention-contracts.js";
export { projectAttentionIdentityReservation } from "./attention/attention-identity-reservation.js";
export type { AttentionIdentityReservationView } from "./attention/attention-identity-reservation.js";
export { projectApprovalReservation } from "./attention/approval-reservation.js";
export type { ApprovalReservationView } from "./attention/approval-reservation.js";
export { projectAttentionIndex } from "./attention/attention-index.js";
export type {
  AttentionIndexView,
  IndexedMaterialAttention,
} from "./attention/attention-index.js";
export { projectAttention } from "./attention/attention-projection.js";
export type {
  AttentionResolution,
  AttentionStatus,
  AttentionView,
} from "./attention/attention-projection.js";
export { AttentionService } from "./attention/attention-service.js";
export type {
  DecisionSubmission,
  RequestApprovalInput,
  RequestQuestionInput,
  TrustedClock,
} from "./attention/attention-service.js";
export { AttentionControlledDispatcher } from "./attention/attention-dispatcher.js";
export type {
  AttentionDispatchResult,
  ScopeDependencies,
} from "./attention/attention-dispatcher.js";
export { AgentTailJsonlFileSink } from "./observability/agent-tail-file-sink.js";
export { AgentTailSegmentStore } from "./observability/agent-tail-segment-store.js";
export type {
  AgentTailSegmentDescriptor,
  AgentTailSegmentLimits,
  AgentTailTraceReport,
} from "./observability/agent-tail-segment-store.js";
export {
  AgentTailTraceService,
  createSegmentedAgentTailProjection,
} from "./observability/agent-tail-trace.js";
export type {
  AgentTailEvent,
  AgentTailIdentities,
  AgentTailRelationship,
} from "./observability/agent-tail.js";
export { loadModelSheet, parseModelSheetMarkdown } from "./policy/model-sheet.js";
export type { ModelCapability, ModelSheet } from "./policy/model-sheet.js";
export { MilestoneRegistry } from "./milestones/milestone-registry.js";
export { loadSecuritySheet, parseSecuritySheetMarkdown } from "./policy/security-sheet.js";
export type { SecuritySheet } from "./policy/security-sheet.js";
export type { RegisterMilestoneInput, MilestoneRecord, MilestoneSummary, OpenCodeTaskAdmissionContext, PlanRevisionResult, ReplaceMilestonePlanInput, ResolveReplanningInput, ReviseMilestonePlanInput, TaskAdmissionResult } from "./milestones/milestone-registry.js";
export type { MilestoneView, PlannedTaskView } from "./milestones/milestone-projection.js";
export {
  AdmissionRequestedBudgetSchema,
  AuthorityAttentionSchema,
  MilestonePausedPayloadSchema,
  OpenCodeAdmissionPacketSchema,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  TaskReadyPayloadSchema,
} from "./contracts/authority-attention.js";
export type {
  AdmissionRequestedBudget,
  AuthorityAttention,
  AuthorityAttentionClassification,
  OpenCodeAdmissionPacket,
  PlanReplacementPayload,
} from "./contracts/authority-attention.js";
export {
  MilestoneBudgetSchema,
  MilestonePlanSchema,
  MilestoneRoleSchema,
  MilestoneSchema,
  PlannedTaskSchema,
  RoleAssignmentSchema,
} from "./contracts/milestone.js";
export { MilestoneTerminalResultSchema, MilestoneTerminalPayloadSchema } from "./contracts/milestone-result.js";
export type { MilestoneTerminalResult, MilestoneEvidenceReference } from "./contracts/milestone-result.js";
export {
  createMilestoneAuthorityEnvelope,
  createReplanningPolicyBinding,
  capabilitySnapshot,
  capabilitySupportsAdmission,
  derivePlanAuthority,
  MilestoneAuthorityEnvelopePayloadSchema,
  MilestoneAuthorityEnvelopeSchema,
  PlanRevisionPayloadSchema,
  PublicReplanningSecuritySnapshotSchema,
  ReplanningAttentionSchema,
  ReplanningCapabilitySchema,
  ReplanningPausedPayloadSchema,
  ReplanningPolicyBindingSchema,
  ReplanningPolicyBoundPayloadSchema,
  ReplanningModelCapabilitySnapshotSchema,
  ReplanningModelSheetSnapshotSchema,
  ReplanningResolutionPayloadSchema,
  RevisionEvidenceReferenceSchema,
} from "./contracts/replanning.js";
export type {
  MilestoneAuthorityEnvelope,
  PlanRevisionPayload,
  ReplanningAttention,
  ReplanningCapability,
  ReplanningReason,
  ReplanningPolicyBinding,
  ReplanningModelSheetSnapshot,
  ReplanningModelCapabilitySnapshot,
  PublicReplanningSecuritySnapshot,
  ReplanningResolutionPayload,
  RevisionEvidenceReference,
} from "./contracts/replanning.js";
export type {
  Milestone,
  MilestoneBudget,
  MilestonePlan,
  MilestoneRole,
  PlannedTask,
  RoleAssignment,
} from "./contracts/milestone.js";
export {
  OpenCodeReviewerAdapter,
  OpenCodeReviewerUncertainError,
} from "./reviews/opencode-reviewer-adapter.js";
export {
  GovernedWebResearch,
  NodeHttpsResearchTransport,
  WebResearchPolicySchema,
  WebResearchRequestSchema,
  WebResearchResultSchema,
  canonicalWebUrl,
} from "./research/web-research.js";
export type {
  WebResearchPolicy,
  WebResearchRequest,
  WebResearchResult,
  WebResearchTransport,
  WebSourceEvidence,
} from "./research/web-research.js";
export {
  RoleCapabilityBindingSchema,
  RoleCapabilityDecisionSchema,
  RoleCapabilityEnvelopeService,
  RoleCapabilityRequestSchema,
  assertRoleModelCapability,
  buildRoleCapabilityBinding,
  evaluateRoleCapabilityRequest,
  roleCapabilityStreamId,
  roleModelSupports,
  roleToolPermissions,
  verifyRoleCapabilityBinding,
} from "./workers/role-capability-envelope.js";
export {
  CapabilityBoundaryOccurrenceSchema,
  CapabilityBoundaryPausedPayloadSchema,
  CapabilityBoundaryResolvedPayloadSchema,
  CapabilityBoundaryResolutionSchema,
  CapabilityTaskHeadSchema,
  capabilityTaskHead,
  createCapabilityBoundaryOccurrence,
  createCapabilityBoundaryResolution,
  verifyCapabilityBoundaryOccurrence,
  verifyCapabilityPauseSource,
  verifyCapabilityResolutionSource,
  verifyCurrentCapabilityTaskHead,
} from "./contracts/capability-boundary.js";
export type { CapabilityBoundaryOccurrence, CapabilityBoundaryResolution } from "./contracts/capability-boundary.js";
export type {
  GovernedRole,
  RoleCapabilityBinding,
  RoleCapabilityBindingInput,
  RoleCapabilityDecision,
  RoleCapabilityExpectedDigests,
  RoleCapabilityRequest,
} from "./workers/role-capability-envelope.js";
export { LocalReleaseCoordinator } from "./release/local-release-coordinator.js";
export type { LocalReleaseCoordinatorResult } from "./release/local-release-coordinator.js";
export { ReleasePreparationConfigSchema } from "./projects/project-config.js";
export type { ReleasePreparationConfig } from "./projects/project-config.js";
export {
  modelSheetSha256,
  routeApprovedModel,
} from "./routing/model-router.js";
export type {
  ApprovedModelSelection,
  RouteApprovedModelRequest,
} from "./routing/model-router.js";
export { JournalOutcomeHistoryStore } from "./routing/outcome-history.js";
export {
  OutcomeHistoryRecordSchema,
  RoutingSelectionSchema,
} from "./routing/routing-events.js";
export { RoutedOpenCodeExecution } from "./routing/routed-opencode-execution.js";
export type { OpenCodeCapabilityProbe } from "./routing/routed-opencode-execution.js";
export type {
  OutcomeHistoryRecord,
  RoutingSelection,
} from "./routing/routing-events.js";
export type {
  OpenCodeReviewerAssignment,
  OpenCodeReviewerProgram,
} from "./reviews/opencode-reviewer-adapter.js";
export {
  RUNTIME_SCHEMA_VERSION,
  RuntimeStateManager,
  discoverProject,
  initializeProjectRuntime,
} from "./runtime/repository-runtime.js";
export { AgentTrailSupervisor } from "./agenttrail/agenttrail-supervisor.js";
export type {
  AgentTrailEvidence,
  AgentTrailFailedEvidence,
  AgentTrailReady,
  AgentTrailReadyEvidence,
  AgentTrailRestartedEvidence,
  AgentTrailStartRequest,
  AgentTrailStartingEvidence,
  AgentTrailSupervisorOptions,
} from "./agenttrail/agenttrail-supervisor.js";
export {
  AGENTTRAIL_EVENT_SCHEMA_VERSION,
  AgentTrailEvidenceSchema,
  AgentTrailFailedEvidenceSchema,
  AgentTrailReadyEvidenceSchema,
  AgentTrailRestartedEvidenceSchema,
  AgentTrailStartingEvidenceSchema,
  JournalAgentTrailEvidenceSink,
  agentTrailStreamId,
  replayAgentTrailEvidence,
} from "./agenttrail/agenttrail-events.js";
export type {
  AgentTrailJournalContext,
  ReplayAgentTrailEvidenceOptions,
} from "./agenttrail/agenttrail-events.js";
export { createJournaledAgentTrailSupervisor } from "./agenttrail/agenttrail-composition.js";
export type {
  JournaledAgentTrail,
  JournaledAgentTrailOptions,
} from "./agenttrail/agenttrail-composition.js";
export {
  packagedAgentTrailRoot,
  resolvePackagedAgentTrail,
} from "./agenttrail/package-attestation.js";
export type { PackagedAgentTrail } from "./agenttrail/package-attestation.js";
export {
  RUN_SCHEMA_VERSION,
  IntakeClosureReferenceSchema,
  PreflightFailedPayloadSchema,
  PreflightPayloadSchema,
  ProjectRevisionSchema,
  RunAcceptedPayloadSchema,
  RunAnalysisCompletedPayloadSchema,
  RunActorSchema,
  RunAuthoritySchema,
  RunBudgetSchema,
  RunCancelledPayloadSchema,
  RunLifecycleSchema,
  RunIntakeCompletedPayloadSchema,
  RunPlanRevisedPayloadSchema,
  RunProcessSchema,
  RunReadyPayloadSchema,
  RunSourceSchema,
  ServiceReadyPayloadSchema,
  ServiceShutdownPayloadSchema,
  ServiceStoppingPayloadSchema,
  ServiceStartingPayloadSchema,
  runStreamId,
  serviceStreamId,
} from "./runs/run-contracts.js";
export {
  IntakeArtifactReferenceSchema,
  IntakeLimitsSchema,
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceProvenanceSchema,
  SourceRejectedPayloadSchema,
  SourceRejectionReasonSchema,
  computeIntakeArtifactAggregateSha256,
  computeIntakeSnapshotSha256,
} from "./intake/intake-contracts.js";
export type {
  IntakeArtifactReference,
  IntakeLimits,
  IntakeSnapshotClosedPayload,
  SourceDiscoveredPayload,
  SourceRejectedPayload,
} from "./intake/intake-contracts.js";
export type {
  IntakeClosureReference,
  ProjectRevision,
  RunActor,
  RunAuthority,
  RunBudget,
  RunLifecycle,
  RunProcess,
  RunSource,
} from "./runs/run-contracts.js";
export { projectRun } from "./runs/run-projection.js";
export type { RunView } from "./runs/run-projection.js";
export { RunService } from "./runs/run-service.js";
export type { AcceptRunInput, RunCommandContext } from "./runs/run-service.js";
export { RunPreflightCoordinator } from "./runs/run-preflight.js";
export { ServiceLifecycleService } from "./runs/service-lifecycle.js";
export { LoopbackGateway } from "./gateway/loopback-gateway.js";
export type { GatewayReadiness, GatewaySession, LoopbackGatewayOptions } from "./gateway/loopback-gateway.js";
export {
  GATEWAY_EVENT_SCHEMA_VERSION,
  GatewayBackfillTargetPayloadSchema,
  GatewayDegradedPayloadSchema,
  GatewayLifecycleService,
  GatewayRecoveredPayloadSchema,
  replayGatewayLifecycle,
} from "./gateway/gateway-events.js";
export type { GatewayLifecycleEvidence, GatewayLifecycleIdentity } from "./gateway/gateway-events.js";
export {
  SERVICE_ATTENTION_SCHEMA_VERSION,
  ServiceCriticalAttentionPayloadSchema,
  replayServiceAttention,
} from "./gateway/service-attention.js";
export type { ServiceAttentionEvidence } from "./gateway/service-attention.js";
export { startZentraService } from "./service/start-service.js";
export type {
  AgentTrailService,
  GatewayService,
  RunningZentraService,
  RuntimeStateService,
  ServiceTraceSink,
  ServiceShutdownReason,
  StartZentraServiceDependencies,
  StartZentraServiceOptions,
} from "./service/start-service.js";
export { projectRevisionMatches, resolveProjectRevision } from "./runs/project-revision.js";
export {
  BoundedTicketIntake,
  IntakeError,
  decodeTicketText,
  normalizeSourceRelativePath,
} from "./intake/ticket-intake.js";
export { IntakeService, intakeStreamId } from "./intake/intake-service.js";
export type { IntakeAnalysisResult, IntakeServiceRequest, IntakeServiceResult } from "./intake/intake-service.js";
export { IntakeArtifactStore } from "./intake/intake-artifact-store.js";
export type { PreparedIntakeArtifact } from "./intake/intake-artifact-store.js";
export type {
  DiscoveredTicketSource,
  RejectedTicketSource,
  SourceIntakeEvent,
  SourceProvenance,
  SourceRejectionReason,
  TicketIntakeLimits,
  TicketIntakeRequest,
  TicketIntakeSnapshot,
  TicketIntakeSource,
  TicketTextDecodeResult,
} from "./intake/ticket-intake.js";
export type {
  ProjectDiscoveredEvidence,
  ProjectDiscovery,
  ProjectRuntimeLayout,
  RuntimeClaim,
  RuntimeOwnership,
  RuntimePublicationEvidence,
  RuntimeState,
  RuntimeStateInput,
  ServiceStartingEvidence,
  StaleRuntimeEvidence,
} from "./runtime/repository-runtime.js";
