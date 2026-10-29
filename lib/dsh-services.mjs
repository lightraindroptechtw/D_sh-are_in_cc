/** The DSH service vocabulary the analyzer and the module registry accept.
 * Anything else a plugin touches on its context is only "uncertain evidence": it is reported,
 * never turned into a required service and never given to root.provide().
 * Names added for the 100-plugin review: shell, subagents, subprocess, workspaceRegistry,
 * connection, sessionController, agentDefaultModel (all injected by real plugins).
 * Added for the Claude host: storageDomain, userQuestions, jobs (storage is already listed). */
export const DSH_SERVICES=Object.freeze(new Set(['tools','systemPrompt','settings','webServer','sessionQuery','sessions','agents','skills','commands','credentials','approval','llm','web','fs','timer','profileContext','webRuntime','attachments','attachment','sandbox','launchEnvironment','pluginPackages','dshHomePath','configEditor','loader','lifecycle','storage','database','http','modelRegistry','models','prompts','shell','subagents','subprocess','workspaceRegistry','connection','sessionController','agentDefaultModel','storageDomain','userQuestions','jobs']));
export const isKnownDshService=name=>typeof name==='string'&&DSH_SERVICES.has(name);
