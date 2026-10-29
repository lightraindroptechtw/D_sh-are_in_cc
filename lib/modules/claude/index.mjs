import * as timer from '../timer.mjs';
import * as fs from '../fs.mjs';
import * as settings from '../settings.mjs';
import * as webServer from '../webserver.mjs';
import * as skills from '../skills.mjs';
import * as web from '../web.mjs';
import * as background from '../background.mjs';
import * as commands from './commands.mjs';
import * as approval from './approval.mjs';
import * as systemPrompt from './system-prompt.mjs';
import * as interception from './interception.mjs';
import * as agents from './agents.mjs';
import * as llm from './llm.mjs';
import * as shell from './shell.mjs';
import * as subprocess from './subprocess.mjs';
import * as subagents from './subagents.mjs';
import * as credentials from './credentials.mjs';
import * as storageDomain from './storage-domain.mjs';
import * as userQuestions from './user-questions.mjs';
import * as jobs from './jobs.mjs';
import * as connection from './connection.mjs';
import * as agentDefaultModel from './default-model.mjs';
import * as uiConnection from '../connection.mjs';
import * as uiTypert from '../typert.mjs';

/** Pseudo capabilities of the Claude Code host. These modules need no outside app server;
 * `mcp`/`skills` only satisfy the requirement of the reused official-package modules. */
export const claudeCapabilities=Object.freeze({host:'claude',mcp:true,skills:true});

/** Ordered by service dependency: official registries first, agents later. */
export const claudeRegistry=new Map([timer,fs,settings,webServer,skills,commands,approval,web,systemPrompt,interception,agents,subagents,llm,credentials,shell,subprocess,storageDomain,userQuestions,jobs,connection,agentDefaultModel,background].map(module=>[module.descriptor.id,module]));
/** For a package that has a browser screen: the screen's real connection channel and remote-method (typert) services replace the
 * "nobody connected" connection stand-in above. Packages without a screen keep claudeRegistry unchanged. */
export const claudeUiRegistry=new Map([...claudeRegistry].flatMap(([id,module])=>id==='connection'?[['connection',uiConnection],['typert',uiTypert]]:[[id,module]]));
export {createClaudeBridgeAgent} from './common.mjs';
export {runCommand} from './commands.mjs';
export {interceptPre,interceptPost} from './interception.mjs';
export {collectPromptSections} from './system-prompt.mjs';
