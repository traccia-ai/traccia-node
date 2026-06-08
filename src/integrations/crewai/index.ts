/**
 * Traccia integration for CrewAI framework.
 */

let instrumented = false;

/**
 * Install Traccia tracing for CrewAI.
 */
export function install(enabled?: boolean): boolean {
  if (instrumented) {
    return true;
  }

  if (enabled === false) {
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crewai = require("crewai");
    if (!crewai) {
      return false;
    }

    const { Agent, Crew, Task } = crewai;
    const traccia = require("../../index");

    // Wrap Crew methods
    if (Crew && Crew.prototype) {
      const originalKickoff = Crew.prototype.kickoff;
      if (originalKickoff) {
        Crew.prototype.kickoff = function (...args: unknown[]) {
          const tracer = traccia.getTracer("crewai");
          const crew = this;
          const attributes: Record<string, unknown> = {
            "crewai.crew.id": String((crew as { id?: string }).id || ""),
            "crewai.type": "crew",
          };

          const span = tracer.startSpan("crewai.crew.kickoff", attributes);

          try {
            const result = originalKickoff.apply(crew, args);
            span.setAttribute("crewai.crew.output", String(result).slice(0, 1000));
            return result;
          } catch (e) {
            const error = e as Error;
            span.setAttribute("error", true);
            span.setAttribute("error.message", error.message);
            throw e;
          } finally {
            span.end();
          }
        };
      }

      const originalKickoffAsync = Crew.prototype.kickoffAsync;
      if (originalKickoffAsync) {
        Crew.prototype.kickoffAsync = async function (...args: unknown[]) {
          const tracer = traccia.getTracer("crewai");
          const crew = this;
          const attributes: Record<string, unknown> = {
            "crewai.crew.id": String((crew as { id?: string }).id || ""),
            "crewai.type": "crew",
          };

          const span = tracer.startSpan("crewai.crew.kickoff_async", attributes);

          try {
            const result = await originalKickoffAsync.apply(crew, args);
            span.setAttribute("crewai.crew.output", String(result).slice(0, 1000));
            return result;
          } catch (e) {
            const error = e as Error;
            span.setAttribute("error", true);
            span.setAttribute("error.message", error.message);
            throw e;
          } finally {
            span.end();
          }
        };
      }
    }

    // Wrap Task methods
    if (Task && Task.prototype) {
      const originalExecuteSync = Task.prototype.execute_sync;
      if (originalExecuteSync) {
        Task.prototype.execute_sync = function (...args: unknown[]) {
          const tracer = traccia.getTracer("crewai");
          const task = this;
          const taskName = (task as { name?: string }).name || (task as { description?: string }).description || "task";
          const attributes: Record<string, unknown> = {
            "crewai.task.id": String((task as { id?: string }).id || ""),
            "crewai.type": "task",
            "crewai.task.name": String(taskName).slice(0, 50),
          };

          const span = tracer.startSpan(`crewai.task.${taskName}`, attributes);

          try {
            const result = originalExecuteSync.apply(task, args);
            return result;
          } catch (e) {
            const error = e as Error;
            span.setAttribute("error", true);
            span.setAttribute("error.message", error.message);
            throw e;
          } finally {
            span.end();
          }
        };
      }
    }

    // Wrap Agent methods
    if (Agent && Agent.prototype) {
      const originalExecuteTask = Agent.prototype.execute_task;
      if (originalExecuteTask) {
        Agent.prototype.execute_task = function (...args: unknown[]) {
          const tracer = traccia.getTracer("crewai");
          const agent = this;
          const agentRole = (agent as { role?: string }).role || "agent";
          const attributes: Record<string, unknown> = {
            "crewai.agent.id": String((agent as { id?: string }).id || ""),
            "crewai.type": "agent",
            "crewai.agent.role": agentRole,
          };

          const span = tracer.startSpan(`crewai.agent.${agentRole}`, attributes);

          try {
            const result = originalExecuteTask.apply(agent, args);
            span.setAttribute("crewai.agent.result", String(result).slice(0, 1000));
            return result;
          } catch (e) {
            const error = e as Error;
            span.setAttribute("error", true);
            span.setAttribute("error.message", error.message);
            throw e;
          } finally {
            span.end();
          }
        };
      }
    }

    instrumented = true;
    return true;
  } catch (e) {
    // CrewAI not installed or error during install, skip silently
    return false;
  }
}