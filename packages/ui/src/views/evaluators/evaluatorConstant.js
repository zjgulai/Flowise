// TODO: Move this to a config file
export const evaluators = [
    {
        type: 'text',
        name: 'ContainsAny',
        label: 'Contains Any',
        description: 'Returns true if any of the specified comma separated values are present in the response.'
    },
    {
        type: 'text',
        name: 'ContainsAll',
        label: 'Contains All',
        description: 'Returns true if ALL of the specified comma separated values are present in the response.'
    },
    {
        type: 'text',
        name: 'DoesNotContainAny',
        label: 'Does Not Contains Any',
        description: 'Returns true if any of the specified comma separated values are present in the response.'
    },
    {
        type: 'text',
        name: 'DoesNotContainAll',
        label: 'Does Not Contains All',
        description: 'Returns true if ALL of the specified comma separated values are present in the response.'
    },
    {
        type: 'text',
        name: 'StartsWith',
        label: '以...开始',
        description: 'Returns true if the response starts with the specified value.'
    },
    {
        type: 'text',
        name: 'NotStartsWith',
        label: 'Does Not Start With',
        description: 'Returns true if the response does not start with the specified value.'
    },
    {
        type: 'json',
        name: 'IsValidJSON',
        label: '是有效的 JSON',
        description: 'Returns true if the response is a valid JSON.'
    },
    {
        type: 'json',
        name: 'IsNotValidJSON',
        label: '不是有效的 JSON',
        description: 'Returns true if the response is a not a valid JSON.'
    },
    {
        type: 'numeric',
        name: 'totalTokens',
        label: '总令牌数',
        description: 'Sum of Prompt Tokens and Completion Tokens.'
    },
    {
        type: 'numeric',
        label: 'Prompt Tokens',
        name: 'promptTokens',
        description: 'This is the number of tokens in your prompt.'
    },
    {
        type: 'numeric',
        label: 'Completion Tokens',
        name: 'completionTokens',
        description: 'Completion tokens are any tokens that the model generates in response to your input.'
    },
    {
        type: 'numeric',
        label: '总 API 延迟',
        name: 'apiLatency',
        description: 'Total time taken for the Flowise Prediction API call (milliseconds).'
    },
    {
        type: 'numeric',
        label: 'LLM 延迟',
        name: 'llm',
        description: 'Actual LLM invocation time (milliseconds).'
    },
    {
        type: 'numeric',
        label: 'Chatflow Latency',
        name: 'chain',
        description: 'Actual time spent in executing the chatflow (milliseconds).'
    },
    {
        type: 'numeric',
        label: '输出字符长度',
        name: 'responseLength',
        description: 'Number of characters in the response.'
    }
]

export const evaluatorTypes = [
    {
        label: 'Evaluate Result (Text Based)',
        name: 'text',
        description: 'Set of Evaluators to evaluate the result of a Chatflow.'
    },
    {
        label: 'Evaluate Result (JSON)',
        name: 'json',
        description: 'Set of Evaluators to evaluate the JSON response of a Chatflow.'
    },
    {
        label: 'Evaluate Metrics (Numeric)',
        name: 'numeric',
        description: 'Set of Evaluators that evaluate the metrics (latency, tokens, cost, length of response) of a Chatflow.'
    },
    {
        label: '基于 LLM 的评分（JSON）',
        name: 'llm',
        description: 'Post execution, grades the answers by using an LLM.'
    }
]

export const numericOperators = [
    {
        label: 'Equals',
        name: 'equals'
    },
    {
        label: '不等于',
        name: 'notEquals'
    },
    {
        label: 'Greater Than',
        name: 'greaterThan'
    },
    {
        label: '小于',
        name: 'lessThan'
    },
    {
        label: 'Greater Than or Equals',
        name: 'greaterThanOrEquals'
    },
    {
        label: '小于或等于',
        name: 'lessThanOrEquals'
    }
]
