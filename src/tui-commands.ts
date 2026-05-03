export interface SlashCommandSpec {
  name: string;
  usage: string;
  description: string;
  aliases?: string[];
  insertText?: string;
  requiresArgument?: boolean;
}

export interface SlashCommandSuggestion extends SlashCommandSpec {
  score: number;
  index?: number;
}

export const slashCommandSpecs: SlashCommandSpec[] = [
  {
    name: "start",
    usage: "/start [run-id]",
    description: "Resume the default run or the specified saved run/thread.",
    aliases: ["run", "resume-run"],
    insertText: "/start ",
  },
  {
    name: "new",
    usage: "/new [prompt]",
    description: "Start a new ordinary task session with a fresh thread.",
    aliases: ["clear"],
    insertText: "/new ",
  },
  {
    name: "goal",
    usage: "/goal <prompt>",
    description: "Reset SuperCodex state and start an explicit final-goal delivery loop.",
    insertText: "/goal ",
    requiresArgument: true,
  },
  {
    name: "status",
    usage: "/status",
    description: "Show current run, thread, turn, settings, auth, and next work.",
    aliases: ["state"],
  },
  {
    name: "runs",
    usage: "/runs",
    description: "List saved Codex/SuperCodex sessions for this project.",
  },
  {
    name: "model",
    usage: "/model <name>",
    description: "Queue model for the next turn.",
  },
  {
    name: "reasoning",
    usage: "/reasoning <minimal|low|medium|high|xhigh>",
    description: "Queue reasoning effort for the next turn.",
    aliases: ["think"],
  },
  {
    name: "auth",
    usage: "/auth <name>",
    description: "Switch saved Codex auth immediately when idle, or queue it for the next turn.",
  },
  {
    name: "permissions",
    usage: "/permissions [default|auto-review|full-access]",
    description: "Show or set the next-turn Codex permission mode.",
    aliases: ["permission", "perms"],
  },
  {
    name: "sandbox",
    usage: "/sandbox <read-only|workspace-write|danger-full-access>",
    description: "Set the Codex sandbox mode for the next turn.",
  },
  {
    name: "approval",
    usage: "/approval <never|on-failure|on-request|untrusted>",
    description: "Set when Codex asks for approval before commands.",
    aliases: ["ask-for-approval"],
  },
  {
    name: "fresh-next",
    usage: "/fresh-next",
    description: "Force the next cycle to start a fresh Codex thread.",
    aliases: ["fresh"],
  },
  {
    name: "interrupt",
    usage: "/interrupt [prompt]",
    description: "Interrupt current turn. Optional prompt is injected into the next turn.",
    aliases: ["stop"],
    insertText: "/interrupt ",
  },
  {
    name: "interactions",
    usage: "/interactions",
    description: "List pending Codex approval, permission, and input requests.",
    aliases: ["requests", "approvals"],
  },
  {
    name: "approve",
    usage: "/approve [interaction-id]",
    description: "Approve the first pending Codex interaction, or the specified one.",
    aliases: ["allow", "yes"],
  },
  {
    name: "approve-session",
    usage: "/approve-session [interaction-id]",
    description: "Approve a pending Codex interaction for the session when supported.",
    aliases: ["allow-session"],
  },
  {
    name: "deny",
    usage: "/deny [interaction-id]",
    description: "Decline the first pending Codex interaction, or the specified one.",
    aliases: ["decline", "no"],
  },
  {
    name: "cancel",
    usage: "/cancel [interaction-id]",
    description: "Cancel the first pending Codex interaction, or the specified one.",
  },
  {
    name: "answer",
    usage: "/answer <text-or-json>",
    description: "Answer a Codex user-input or MCP elicitation request.",
    insertText: "/answer ",
    requiresArgument: true,
  },
  {
    name: "pause",
    usage: "/pause",
    description: "Pause before the next turn.",
  },
  {
    name: "resume",
    usage: "/resume [number|run-id|current]",
    description: "Show a session picker or select a saved session; use current to unpause the active run.",
  },
  {
    name: "help",
    usage: "/help",
    description: "Show available commands.",
    aliases: ["?"],
  },
  {
    name: "exit",
    usage: "/exit",
    description: "Leave the TUI.",
    aliases: ["quit"],
  },
];

const slashCommandAliases = new Map<string, string>(
  slashCommandSpecs.flatMap((command) => [
    [command.name.toLowerCase(), command.name.toLowerCase()],
    ...(command.aliases ?? []).map((alias): [string, string] => [alias.toLowerCase(), command.name.toLowerCase()]),
  ]),
);

export function canonicalSlashCommandName(value: string): string {
  const normalized = value.trim().toLowerCase();
  return slashCommandAliases.get(normalized) ?? normalized;
}

export function shouldShowSlashPalette(input: string, cursor = input.length): boolean {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  return beforeCursor.startsWith("/") && !/\s/.test(beforeCursor.slice(1));
}

export function slashCommandSuggestions(input: string, cursor = input.length): SlashCommandSuggestion[] {
  if (!shouldShowSlashPalette(input, cursor)) {
    return [];
  }
  const query = input.slice(1, Math.max(0, Math.min(cursor, input.length))).toLowerCase();
  const scored: Array<SlashCommandSuggestion & { index: number }> = slashCommandSpecs
    .flatMap((command, index) => {
      const candidates = [command.name, command.usage, command.description, ...(command.aliases ?? [])].map((item) => item.toLowerCase());
      const exactPrefix = command.name.toLowerCase().startsWith(query);
      const aliasPrefix = (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(query));
      const contains = candidates.some((candidate) => candidate.includes(query));
      if (query && !exactPrefix && !aliasPrefix && !contains) {
        return [];
      }
      const score = query
        ? exactPrefix
          ? 3
          : aliasPrefix
            ? 2
            : contains
              ? 1
              : 0
        : 1;
      return [{ ...command, score, index }];
    });
  return scored.sort((a, b) => b.score - a.score || (a.index ?? 0) - (b.index ?? 0));
}

export function slashHelpText(): string {
  return [
    "Commands:",
    ...slashCommandSpecs.map((command) => `  ${command.usage.padEnd(40)} ${command.description}`),
    "",
    "Plain text starts an ordinary task session when idle, or steers the active turn when SuperCodex is running. Use /goal <prompt> to reset state and start a final-goal loop.",
  ].join("\n");
}
