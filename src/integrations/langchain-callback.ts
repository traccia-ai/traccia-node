import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Document } from "@langchain/core/documents";
import type { Serialized } from "@langchain/core/load/serializable";
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  type UsageMetadata,
  type BaseMessageFields,
  type MessageContent,
} from "@langchain/core/messages";
import type { Generation, LLMResult } from "@langchain/core/outputs";
import type { ChainValues } from "@langchain/core/utils/types";
import { getTracer } from '../auto';
import { ISpan } from '../types';
import { getCurrentSpan } from "../context/context";

type LangfusePrompt = {
  name: string;
  version: number;
  isFallback: boolean;
};

export type LlmMessage = {
  role: string;
  content: BaseMessageFields["content"];
  additional_kwargs?: BaseMessageFields["additional_kwargs"];
};

export type AnonymousLlmMessage = {
  content: BaseMessageFields["content"];
  additional_kwargs?: BaseMessageFields["additional_kwargs"];
};

type ConstructorParams = {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  version?: string; // added to all traces and observations
  traceMetadata?: Record<string, unknown>; // added to all traces
};

export class TracciaCallbackHandler extends BaseCallbackHandler {
  name = "TracciaCallbackHandler";
  private tracer = getTracer('langchain');

  private tags: string[] | undefined = [];

  private completionStartTimes: Record<string, Date> = {};
  private promptToParentRunMap;
  private runMap: Map<string, ISpan> = new Map();

  public last_trace_id: string | null = null;

  // PATCH: Store root trace persistently across agent execution
  private persistentRootTraceId: string | null = null;
  private persistentRootSpan: ISpan | null = null;

  constructor(params?: ConstructorParams) {
    super();

    this.tags = params?.tags ?? [];

    this.promptToParentRunMap = new Map<string, LangfusePrompt>();
  }

  async handleLLMNewToken(
    _token: string,
    _idx: any,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _fields?: any,
  ): Promise<void> {
    // if this is the first token, add it to completionStartTimes
    if (runId && !(runId in this.completionStartTimes)) {
      console.debug(`LLM first streaming token: ${runId}`);
      this.completionStartTimes[runId] = new Date();
    }
  }

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    _runType?: string,
    name?: string,
  ): Promise<void> {
    try {
      console.debug(`Chain start with Id: ${runId}`);
      this.tags;

      const runName = name ?? chain.id.at(-1)?.toString() ?? "Langchain Run";

      this.registerLangfusePrompt(parentRunId, metadata);

      // In chains, inputs can be a string or an array of BaseMessage
      let finalInput: string | ChainValues = inputs;
      if (
        typeof inputs === "object" &&
        "input" in inputs &&
        Array.isArray(inputs["input"]) &&
        inputs["input"].every((m: unknown) => m instanceof BaseMessage)
      ) {
        finalInput = inputs["input"].map((m: BaseMessage) =>
          this.extractChatMessageContent(m),
        );
      } else if (
        typeof inputs === "object" &&
        "messages" in inputs &&
        Array.isArray(inputs["messages"]) &&
        inputs["messages"].every((m: unknown) => m instanceof BaseMessage)
      ) {
        finalInput = inputs["messages"].map((m: BaseMessage) =>
          this.extractChatMessageContent(m),
        );
      } else if (
        typeof inputs === "object" &&
        "content" in inputs &&
        typeof inputs["content"] === "string"
      ) {
        finalInput = inputs["content"];
      }

      this.startAndRegisterSpan({
        runName,
        parentRunId,
        runId,
        tags,
        metadata,
        attributes: {
          input: finalInput,
        },
      });

      if (!parentRunId) {
        // Here we would update the trace, but traccia sdk doesn't support it yet
      }
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleAgentAction(
    action: AgentAction,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    try {
      console.debug(`Agent action ${action.tool} with ID: ${runId}`);
      this.startAndRegisterSpan({
        runId,
        parentRunId,
        runName: action.tool,
        attributes: {
          input: action,
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleAgentEnd?(
    action: AgentFinish,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    try {
      console.debug(`Agent finish with ID: ${runId}`);

      this.handleSpanEnd({
        runId,
        attributes: { output: action },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleChainError(
    err: any,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Chain error: ${err} with ID: ${runId}`);

      const azureRefusalError = this.parseAzureRefusalError(err);

      this.handleSpanEnd({
        runId,
        attributes: {
          level: "ERROR",
          statusMessage: err.toString() + azureRefusalError,
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleGenerationStart(
    llm: Serialized,
    messages: (LlmMessage | MessageContent | AnonymousLlmMessage)[],
    runId: string,
    parentRunId?: string | undefined,
    extraParams?: Record<string, unknown> | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<void> {
    console.debug(
      `Generation start with ID: ${runId} and parentRunId ${parentRunId}`,
    );

    const runName = name ?? llm.id.at(-1)?.toString() ?? "Langchain Generation";

    const modelParameters: Record<string, any> = {};
    const invocationParams = extraParams?.["invocation_params"];

    for (const [key, value] of Object.entries({
      temperature: (invocationParams as any)?.temperature,
      max_tokens: (invocationParams as any)?.max_tokens,
      top_p: (invocationParams as any)?.top_p,
      frequency_penalty: (invocationParams as any)?.frequency_penalty,
      presence_penalty: (invocationParams as any)?.presence_penalty,
      request_timeout: (invocationParams as any)?.request_timeout,
    })) {
      if (value !== undefined && value !== null) {
        modelParameters[key] = value;
      }
    }

    interface InvocationParams {
      _type?: string;
      model?: string;
      model_name?: string;
      repo_id?: string;
    }

    let extractedModelName: string | undefined;
    if (extraParams) {
      const invocationParamsModelName = (
        extraParams.invocation_params as InvocationParams
      ).model;
      const metadataModelName =
        metadata && "ls_model_name" in metadata
          ? (metadata["ls_model_name"] as string)
          : undefined;

      extractedModelName = invocationParamsModelName ?? metadataModelName;
    }

    const registeredPrompt = this.promptToParentRunMap.get(
      parentRunId ?? "root",
    );
    if (registeredPrompt && parentRunId) {
      this.deregisterTracciaPrompt(parentRunId);
    }

    this.startAndRegisterSpan({
      runId,
      parentRunId,
      metadata,
      tags,
      runName,
      attributes: {
        input: messages,
        model: extractedModelName,
        modelParameters: modelParameters,
        prompt: registeredPrompt,
      },
    });
  }

  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string | undefined,
    extraParams?: Record<string, unknown> | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<void> {
    try {
      console.debug(`Chat model start with ID: ${runId}`);

      const prompts = messages.flatMap((message) =>
        message.map((m) => this.extractChatMessageContent(m)),
      );

      this.handleGenerationStart(
        llm,
        prompts,
        runId,
        parentRunId,
        extraParams,
        tags,
        metadata,
        name,
      );
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleChainEnd(
    outputs: ChainValues,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Chain end with ID: ${runId}`);

      let finalOutput: ChainValues | string = outputs;
      if (
        typeof outputs === "object" &&
        "output" in outputs &&
        typeof outputs["output"] === "string"
      ) {
        finalOutput = outputs["output"];
      } else if (
        typeof outputs === "object" &&
        "messages" in outputs &&
        Array.isArray(outputs["messages"]) &&
        outputs["messages"].every((m: unknown) => m instanceof BaseMessage)
      ) {
        finalOutput = {
          messages: outputs.messages.map((message: BaseMessage) =>
            this.extractChatMessageContent(message),
          ),
        };
      }

      this.handleSpanEnd({
        runId,
        attributes: {
          output: finalOutput,
        },
      });
      this.deregisterTracciaPrompt(runId);
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string | undefined,
    extraParams?: Record<string, unknown> | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<void> {
    try {
      console.debug(`LLM start with ID: ${runId}`);

      this.handleGenerationStart(
        llm,
        prompts,
        runId,
        parentRunId,
        extraParams,
        tags,
        metadata,
        name,
      );
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<void> {
    try {
      console.debug(`Tool start with ID: ${runId}`);

      this.startAndRegisterSpan({
        runId,
        parentRunId,
        runName: name ?? tool.id.at(-1)?.toString() ?? "Tool execution",
        attributes: {
          input,
        },
        metadata,
        tags,
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string | undefined,
    tags?: string[] | undefined,
    metadata?: Record<string, unknown> | undefined,
    name?: string,
  ): Promise<void> {
    try {
      console.debug(`Retriever start with ID: ${runId}`);

      this.startAndRegisterSpan({
        runId,
        parentRunId,
        runName: name ?? retriever.id.at(-1)?.toString() ?? "Retriever",
        attributes: {
          input: query,
        },
        tags,
        metadata,
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleRetrieverEnd(
    documents: Document<Record<string, any>>[],
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Retriever end with ID: ${runId}`);

      this.handleSpanEnd({
        runId,
        attributes: {
          output: documents,
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleRetrieverError(
    err: any,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Retriever error: ${err} with ID: ${runId}`);
      this.handleSpanEnd({
        runId,
        attributes: {
          level: "ERROR",
          statusMessage: err.toString(),
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }
  async handleToolEnd(
    output: string,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Tool end with ID: ${runId}`);

      this.handleSpanEnd({
        runId,
        attributes: { output },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleToolError(
    err: any,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`Tool error ${err} with ID: ${runId}`);

      this.handleSpanEnd({
        runId,
        attributes: {
          level: "ERROR",
          statusMessage: err.toString(),
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`LLM end with ID: ${runId}`);

      const lastResponse =
        output.generations[output.generations.length - 1][
        output.generations[output.generations.length - 1].length - 1
        ];
      const llmUsage =
        this.extractUsageMetadata(lastResponse) ??
        output.llmOutput?.["tokenUsage"];
      const modelName = this.extractModelNameFromMetadata(lastResponse);

      const usageDetails: Record<string, any> = {
        input:
          llmUsage?.input_tokens ??
          (llmUsage && "promptTokens" in llmUsage ? llmUsage?.promptTokens : undefined),
        output:
          llmUsage?.output_tokens ??
          (llmUsage && "completionTokens" in llmUsage
            ? llmUsage?.completionTokens
            : undefined),
        total:
          llmUsage?.total_tokens ??
          (llmUsage && "totalTokens" in llmUsage ? llmUsage?.totalTokens : undefined),
      };

      if (llmUsage && "input_token_details" in llmUsage) {
        for (const [key, val] of Object.entries(
          llmUsage["input_token_details"] ?? {},
        )) {
          usageDetails[`input_${key}`] = val;

          if ("input" in usageDetails && typeof val === "number") {
            usageDetails["input"] = Math.max(0, usageDetails["input"] - val);
          }
        }
      }

      if (llmUsage && "output_token_details" in llmUsage) {
        for (const [key, val] of Object.entries(
          llmUsage["output_token_details"] ?? {},
        )) {
          usageDetails[`output_${key}`] = val;

          if ("output" in usageDetails && typeof val === "number") {
            usageDetails["output"] = Math.max(0, usageDetails["output"] - val);
          }
        }
      }

      const extractedOutput =
        "message" in lastResponse
          ? this.extractChatMessageContent(
            lastResponse["message"] as BaseMessage,
          )
          : lastResponse.text;

      this.handleSpanEnd({
        runId,
        attributes: {
          model: modelName,
          output: extractedOutput,
          completionStartTime:
            runId in this.completionStartTimes
              ? this.completionStartTimes[runId]
              : undefined,
          usageDetails: usageDetails,
        },
      });

      if (runId in this.completionStartTimes) {
        delete this.completionStartTimes[runId];
      }
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  async handleLLMError(
    err: any,
    runId: string,
    parentRunId?: string | undefined,
  ): Promise<void> {
    try {
      console.debug(`LLM error ${err} with ID: ${runId}`);

      const azureRefusalError = this.parseAzureRefusalError(err);

      this.handleSpanEnd({
        runId,
        attributes: {
          level: "ERROR",
          statusMessage: err.toString() + azureRefusalError,
        },
      });
    } catch (e) {
      console.debug(e instanceof Error ? e.message : String(e));
    }
  }

  private registerLangfusePrompt(
    parentRunId?: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (metadata && "langfusePrompt" in metadata && parentRunId) {
      this.promptToParentRunMap.set(
        parentRunId,
        metadata.langfusePrompt as LangfusePrompt,
      );
    }
  }

  private deregisterTracciaPrompt(runId: string): void {
    this.promptToParentRunMap.delete(runId);
  }

  private startAndRegisterSpan(params: {
    runName: string;
    runId: string;
    parentRunId?: string;
    attributes: Record<string, any>;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): ISpan {
    const { runName, runId, parentRunId, attributes, metadata, tags } = params;

    // Look up parent span if parentRunId is provided
    const parentSpan = parentRunId ? this.runMap.get(parentRunId) : undefined;

    const spanOptions: any = {
      attributes: {
        ...attributes,
        ...this.joinTagsAndMetaData(tags, metadata)
      }
    };

    console.log(`🔍 TRACCIA PATCH: Starting span: ${runName}, runId: ${runId}, parentRunId: ${parentRunId}`);

    // ENHANCED FIX: Use persistent root trace storage
    if (runName === 'AgentExecutor') {
      console.log(`🌱 TRACCIA PATCH: Creating new root trace for AgentExecutor`);
      // Let this create a new root trace
    }
    // For all other operations, use the stored root trace
    else if (this.persistentRootTraceId) {
      spanOptions.parentContext = {
        traceId: this.persistentRootTraceId,
        spanId: this.persistentRootSpan ? this.persistentRootSpan.context.spanId : undefined,
        traceFlags: 1
      };
      console.log(`✅ TRACCIA PATCH: Using persistent root trace: ${this.persistentRootTraceId} -> ${runName}`);
    }
    // Try parent span from runMap
    else if (parentSpan) {
      spanOptions.parent = parentSpan;
      console.log(`✅ TRACCIA PATCH: Using parent span: ${parentSpan.context.traceId} -> ${runName}`);
    }
    // Fallback
    else {
      const currentSpan = getCurrentSpan();
      if (currentSpan) {
        spanOptions.parent = currentSpan;
        console.log(`✅ TRACCIA PATCH: Using current TraciaSDK span: ${currentSpan.context.traceId} -> ${runName}`);
      } else {
        console.log(`⚠️ TRACCIA PATCH: No parent context found for: ${runName}`);
      }
    }

    const span = this.tracer.startSpan(runName, spanOptions);
    console.log(`🆕 TRACCIA PATCH: Created span: ${runName}, traceId: ${span.context.traceId}, spanId: ${span.context.spanId}`);

    // Store root trace info for AgentExecutor
    if (runName === 'AgentExecutor') {
      this.persistentRootTraceId = span.context.traceId;
      this.persistentRootSpan = span;
      console.log(`💾 TRACCIA PATCH: Stored persistent root trace: ${this.persistentRootTraceId}`);
    }

    this.runMap.set(runId, span);
    return span;
  }

  private handleSpanEnd(params: {
    runId: string;
    attributes?: Record<string, any>;
  }) {
    const { runId, attributes = {} } = params;

    const span = this.runMap.get(runId);
    if (!span) {
      console.warn("Span not found in runMap. Skipping operation");

      return;
    }

    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    span.end();

    this.runMap.delete(runId);
  }
  private parseAzureRefusalError(err: any): string {
    let azureRefusalError = "";
    if (typeof err == "object" && "error" in err) {
      try {
        azureRefusalError =
          "\n\nError details:\n" + JSON.stringify(err["error"], null, 2);
      } catch { }
    }

    return azureRefusalError;
  }

  private joinTagsAndMetaData(
    tags?: string[] | undefined,
    metadata1?: Record<string, unknown> | undefined,
    metadata2?: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const finalDict: Record<string, unknown> = {};
    if (tags && tags.length > 0) {
      finalDict.tags = tags;
    }
    if (metadata1) {
      Object.assign(finalDict, metadata1);
    }
    if (metadata2) {
      Object.assign(finalDict, metadata2);
    }
    return this.stripLangfuseKeysFromMetadata(finalDict);
  }

  private stripLangfuseKeysFromMetadata(
    metadata?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!metadata) {
      return;
    }

    const langfuseKeys = [
      "langfusePrompt",
      "langfuseUserId",
      "langfuseSessionId",
    ];

    return Object.fromEntries(
      Object.entries(metadata).filter(
        ([key, _]) => !langfuseKeys.includes(key),
      ),
    );
  }

  private extractUsageMetadata(
    generation: Generation,
  ): UsageMetadata | undefined {
    try {
      const usageMetadata =
        "message" in generation &&
          (generation["message"] instanceof AIMessage ||
            generation["message"] instanceof AIMessageChunk)
          ? generation["message"].usage_metadata
          : undefined;

      return usageMetadata;
    } catch (err) {
      console.debug(`Error extracting usage metadata: ${err}`);

      return;
    }
  }

  private extractModelNameFromMetadata(generation: any): string | undefined {
    try {
      return "message" in generation &&
        (generation["message"] instanceof AIMessage ||
          generation["message"] instanceof AIMessageChunk)
        ? generation["message"].response_metadata.model_name
        : undefined;
    } catch {
      return undefined;
    }
  }

  private extractChatMessageContent(
    message: BaseMessage,
  ): LlmMessage | AnonymousLlmMessage | MessageContent {
    let response = undefined;

    if (message.getType() === "human") {
      response = { content: message.content, role: "user" };
    } else if (message.getType() === "generic") {
      response = {
        content: message.content,
        role: "human",
      };
    } else if (message.getType() === "ai") {
      response = { content: message.content, role: "assistant" };

      if (
        "tool_calls" in message &&
        Array.isArray(message.tool_calls) &&
        (message.tool_calls?.length ?? 0) > 0
      ) {
        (response as any)[`tool_calls`] = message[`tool_calls`];
      }
      if (
        "additional_kwargs" in message &&
        "tool_calls" in message["additional_kwargs"]
      ) {
        (response as any)[`tool_calls`] =
          message["additional_kwargs"]["tool_calls"];
      }
    } else if (message.getType() === "system") {
      response = { content: message.content, role: "system" };
    } else if (message.getType() === "function") {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name,
      };
    } else if (message.getType() === "tool") {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name,
      };
    } else if (!message.name) {
      response = { content: message.content };
    } else {
      response = {
        role: message.name,
        content: message.content,
      };
    }

    if (
      (message.additional_kwargs.function_call ||
        message.additional_kwargs.tool_calls) &&
      (response as any)[`tool_calls`] === undefined
    ) {
      return { ...response, additional_kwargs: message.additional_kwargs };
    }

    return response;
  }
}