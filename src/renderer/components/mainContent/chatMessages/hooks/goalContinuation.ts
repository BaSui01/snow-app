import { parseTodoResult, type TodoItem } from "./useTodoPanel";

const TODO_TOOL_NAME = "todo-todo-manage";
const TODO_QUERY_TIMEOUT_MS = 15000;

export const readSessionTodos = async (
  conversationId: string,
  directoryId: string | undefined,
): Promise<TodoItem[] | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = window.snow.callMcpTool(
      TODO_TOOL_NAME,
      JSON.stringify({ action: "get" }),
      directoryId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      conversationId,
    );
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TODO_QUERY_TIMEOUT_MS);
    });
    const result = await Promise.race([query, timeout]);
    if (result === null) {
      return null;
    }
    return parseTodoResult(result)?.todos ?? null;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export type GoalContinuationStopReason =
  "not-goal-mode" | "budget-exhausted" | "todos-complete" | "todos-unavailable";

export type GoalContinuationDecision =
  | { kind: "continue"; prompt: string }
  | { kind: "stop"; reason: GoalContinuationStopReason };

const buildBudgetLine = (budgetTokens: number, usedTokens: number): string => {
  if (budgetTokens <= 0) {
    return "Token budget: unlimited.";
  }
  const remaining = Math.max(budgetTokens - usedTokens, 0);
  return `Token budget: about ${usedTokens} of ${budgetTokens} tokens consumed (${remaining} remaining). Start wrapping up near the limit instead of being cut off mid-step.`;
};

export const buildGoalContinuationPrompt = (input: {
  todos: TodoItem[];
  budgetTokens: number;
  usedTokens: number;
  heading: string;
}): string => {
  const { todos, budgetTokens, usedTokens, heading } = input;
  const budgetLine = buildBudgetLine(budgetTokens, usedTokens);
  const title = `## ${heading}`;

  if (todos.length === 0) {
    return [
      title,
      "",
      "You stopped, but Goal Mode requires a tracked plan before substantive work: no TODO item exists for this goal yet.",
      "",
      "Do this now, without asking for permission and without stopping:",
      '1. Call `todo-todo-manage` with `action: "add"` and create the TODO list for the current goal (one item per concrete step; pass `content` as a string array for a batch).',
      "2. Immediately start executing the first item with the appropriate tools.",
      "3. Mark each item `completed` via `todo-todo-manage` as soon as it is verified.",
      "",
      "The goal is complete only when every TODO item is `completed` and the outcome is verified with evidence.",
      budgetLine,
    ].join("\n");
  }

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const pendingLines = todos
    .filter((todo) => todo.status !== "completed")
    .map((todo) => `- [${todo.status}] ${todo.id} ${todo.content}`)
    .join("\n");

  return [
    title,
    "",
    `You stopped, but the TODO list is still unfinished (${completed}/${todos.length} completed). Goal Mode requires continuing until the goal is verifiably achieved.`,
    "",
    "Outstanding TODO items:",
    pendingLines,
    "",
    "Do this now, without asking for permission and without stopping:",
    "1. Continue the outstanding items with the appropriate tools, one focused and verifiable step at a time.",
    '2. Call `todo-todo-manage` with `action: "update"` and the real item id to mark each item `completed` right after it is verified.',
    '3. If an item became obsolete, remove it with `action: "delete"` instead of leaving it pending.',
    "",
    "Do not answer with a plan or a progress summary instead of working. Do not end the turn while any item is still `pending` or `inProgress`.",
    budgetLine,
  ].join("\n");
};

export const resolveGoalContinuation = async (params: {
  goalMode: boolean;
  budgetTokens: number;
  usedTokens: number;
  conversationId: string | undefined;
  directoryId: string | undefined;
  heading: string;
}): Promise<GoalContinuationDecision> => {
  if (!params.goalMode) {
    return { kind: "stop", reason: "not-goal-mode" };
  }
  if (params.budgetTokens > 0 && params.usedTokens >= params.budgetTokens) {
    return { kind: "stop", reason: "budget-exhausted" };
  }
  if (!params.conversationId) {
    return { kind: "stop", reason: "todos-unavailable" };
  }

  const todos = await readSessionTodos(
    params.conversationId,
    params.directoryId,
  );
  if (todos === null) {
    return { kind: "stop", reason: "todos-unavailable" };
  }
  if (todos.length > 0 && todos.every((todo) => todo.status === "completed")) {
    return { kind: "stop", reason: "todos-complete" };
  }

  return {
    kind: "continue",
    prompt: buildGoalContinuationPrompt({
      todos,
      budgetTokens: params.budgetTokens,
      usedTokens: params.usedTokens,
      heading: params.heading,
    }),
  };
};
