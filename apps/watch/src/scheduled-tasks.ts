import {
  parseScheduledTaskRequest, parseScheduledTaskResponse, scheduledTaskFailure,
  type ScheduledTaskRequest, type ScheduledTaskResponse,
} from "@butler/contract";

export interface ScheduledTaskService {
  request(input: ScheduledTaskRequest): Promise<ScheduledTaskResponse>;
}

export function createScheduledTaskService(options: {
  framework: string;
  client?: ScheduledTaskService;
}): ScheduledTaskService {
  return {
    async request(input) {
      const request = parseScheduledTaskRequest(input);
      if (!request) throw new Error("invalid_scheduled_task_request");
      if (options.framework !== "hermes") return scheduledTaskFailure(request, "unsupported_framework", false, false);
      if (!options.client) return scheduledTaskFailure(request, "bridge_not_configured");
      try {
        const response = parseScheduledTaskResponse(request.action, await options.client.request(request));
        if (response && "requestId" in request &&
          (!("requestId" in response) || response.requestId !== request.requestId ||
          ("id" in request && response.taskId !== request.id))) {
          return scheduledTaskFailure(request, "invalid_response");
        }
        return response ?? scheduledTaskFailure(request, "invalid_response");
      } catch { return scheduledTaskFailure(request, "bridge_unreachable"); }
    },
  };
}
