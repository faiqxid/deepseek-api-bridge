// Tool Call Parser untuk DeepSeek API Proxy
// Mengubah format DeepSeek XML/DSML ke OpenAI-compatible tool_calls format
// dan sebaliknya.
//
// DeepSeek menghasilkan tool calls dalam format XML:
//   <tool_calls>
//   <invoke name="..." tool_call_id="...">
//   <parameter name="...">...</parameter>
//   </invoke>
//   </tool_calls>
//
// Atau format DSML (DeepSeek Markup Language):
//   <|DSML|tool_calls>
//   <|DSML|invoke name="..." tool_call_id="...">
//   <|DSML|parameter name="...">...</|DSML|parameter>
//   </|DSML|invoke>
//   </|DSML|tool_calls>
//
// OpenAI format:
//   {
//     "tool_calls": [{
//       "id": "call_123",
//       "type": "function",
//       "function": {
//         "name": "tool_name",
//         "arguments": "{\"arg1\": \"value1\"}"
//       }
//     }]
//   }

import { createLogger } from './logger.js';

const log = createLogger('TOOLCALL');

/**
 * Parse tool calls dari teks DeepSeek ke format OpenAI
 * @param {string} text - Teks yang mungkin mengandung tool calls
 * @returns {Array|null} Array tool calls dalam format OpenAI, atau null jika tidak ada
 */
export function parseToolCallsFromText(text) {
    if (!text || typeof text !== 'string') return null;

    // Cari semua tool calls dalam format XML/DSML
    const toolCallMatches = [];
    
    // Pattern untuk format DSML: <|DSML|tool_calls> ... </|DSML|tool_calls>
    const dsmlPattern = /<\|DSML\|tool_calls>([\s\S]*?)<\/\|DSML\|tool_calls>/gi;
    // Pattern untuk format XML: <tool_calls> ... </tool_calls>
    const xmlPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
    
    let match;
    while ((match = dsmlPattern.exec(text)) !== null) {
        toolCallMatches.push({ type: 'dsml', content: match[1] });
    }
    while ((match = xmlPattern.exec(text)) !== null) {
        toolCallMatches.push({ type: 'xml', content: match[1] });
    }
    
    if (toolCallMatches.length === 0) return null;
    
    const toolCalls = [];
    
    for (const match of toolCallMatches) {
        const { type, content } = match;
        
        // Parse invoke elements
        const invokePattern = type === 'dsml' 
            ? /<\|DSML\|invoke\s+([^>]+)>([\s\S]*?)<\/\|DSML\|invoke>/gi
            : /<invoke\s+([^>]+)>([\s\S]*?)<\/invoke>/gi;
        
        let invokeMatch;
        while ((invokeMatch = invokePattern.exec(content)) !== null) {
            const attrs = parseAttributes(invokeMatch[1]);
            const innerContent = invokeMatch[2];
            
            const toolCallId = attrs.tool_call_id || attrs.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const name = attrs.name || 'unknown_tool';
            
            // Parse parameters
            const paramPattern = type === 'dsml'
                ? /<\|DSML\|parameter\s+([^>]+)>([\s\S]*?)<\/\|DSML\|parameter>/gi
                : /<parameter\s+([^>]+)>([\s\S]*?)<\/parameter>/gi;
            
            const parameters = {};
            let paramMatch;
            while ((paramMatch = paramPattern.exec(innerContent)) !== null) {
                const paramAttrs = parseAttributes(paramMatch[1]);
                const paramName = paramAttrs.name || 'param';
                const paramValue = paramMatch[2].trim();
                parameters[paramName] = paramValue;
            }
            
            // Jika tidak ada parameter, coba parse sebagai JSON
            if (Object.keys(parameters).length === 0) {
                try {
                    // Coba parse inner content sebagai JSON
                    const jsonMatch = innerContent.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const jsonContent = jsonMatch[0];
                        const parsed = JSON.parse(jsonContent);
                        Object.assign(parameters, parsed);
                    }
                } catch (e) {
                    // Jika bukan JSON, gunakan inner content sebagai arguments string
                    parameters.arguments = innerContent.trim();
                }
            }
            
            toolCalls.push({
                id: toolCallId,
                type: 'function',
                function: {
                    name,
                    arguments: JSON.stringify(parameters)
                }
            });
        }
    }
    
    return toolCalls.length > 0 ? toolCalls : null;
}

/**
 * Parse attributes dari string seperti 'name="tool" tool_call_id="123"'
 */
function parseAttributes(attrString) {
    const attrs = {};
    const pattern = /(\w+)=["']([^"']*)["']/g;
    let match;
    while ((match = pattern.exec(attrString)) !== null) {
        attrs[match[1]] = match[2];
    }
    return attrs;
}

/**
 * Convert OpenAI tool calls ke format DeepSeek XML
 * @param {Array} toolCalls - Tool calls dalam format OpenAI
 * @returns {string} XML string untuk dikirim ke DeepSeek
 */
export function convertToolCallsToDeepSeekXML(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
    
    const xmlParts = [];
    
    for (const tc of toolCalls) {
        const name = tc.function?.name || tc.name || 'unknown';
        const args = tc.function?.arguments || tc.arguments || '{}';
        const toolCallId = tc.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        let parsedArgs;
        try {
            parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
        } catch (e) {
            parsedArgs = { arguments: args };
        }
        
        const paramParts = [];
        for (const [key, value] of Object.entries(parsedArgs)) {
            paramParts.push(`<parameter name="${key}">${value}</parameter>`);
        }
        
        xmlParts.push(`<invoke name="${name}" tool_call_id="${toolCallId}">\n${paramParts.join('\n')}\n</invoke>`);
    }
    
    return `<tool_calls>\n${xmlParts.join('\n')}\n</tool_calls>`;
}

/**
 * Extract tool calls dari assistant message OpenAI format
 * @param {Object} message - Assistant message dengan tool_calls
 * @returns {string} XML string untuk dikirim ke DeepSeek
 */
export function extractToolCallsFromAssistantMessage(message) {
    if (!message || !message.tool_calls || !Array.isArray(message.tool_calls)) return '';
    return convertToolCallsToDeepSeekXML(message.tool_calls);
}

/**
 * Check apakah teks mengandung tool calls
 * @param {string} text - Teks untuk dicek
 * @returns {boolean} True jika mengandung tool calls
 */
export function hasToolCalls(text) {
    if (!text) return false;
    return /<\|DSML\|tool_calls>|<tool_calls>/i.test(text);
}

/**
 * Remove tool calls dari teks untuk mendapatkan content murni
 * @param {string} text - Teks yang mungkin mengandung tool calls
 * @returns {string} Teks tanpa tool calls
 */
export function stripToolCalls(text) {
    if (!text) return '';
    
    // Hapus DSML tool calls
    let cleaned = text.replace(/<\|DSML\|tool_calls>[\s\S]*?<\/\|DSML\|tool_calls>/gi, '');
    // Hapus XML tool calls
    cleaned = cleaned.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '');
    
    return cleaned.trim();
}

/**
 * Build tool definitions untuk system prompt
 * @param {Array} tools - Tools dalam format OpenAI
 * @returns {string} System prompt untuk tool definitions
 */
export function buildToolDefinitionsPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    
    const toolDefs = tools.map(tool => {
        const name = tool.function?.name || tool.name;
        const description = tool.function?.description || tool.description || '';
        const parameters = tool.function?.parameters || tool.parameters || {};
        
        let paramDesc = '';
        if (parameters && typeof parameters === 'object') {
            const props = parameters.properties || {};
            paramDesc = Object.entries(props).map(([propName, propDef]) => {
                return `  - ${propName}: ${propDef.description || ''} (${propDef.type || 'string'})`;
            }).join('\n');
        }
        
        return `Tool: ${name}\nDescription: ${description}\nParameters:\n${paramDesc}`;
    }).join('\n\n');
    
    return `Available tools:\n\n${toolDefs}\n\nWhen using tools, output in this exact XML format:\n<tool_calls>\n<invoke name="tool_name" tool_call_id="unique_id">\n<parameter name="param1">value1</parameter>\n</invoke>\n</tool_calls>`;
}

/**
 * Validate tool calls dari request OpenAI
 * @param {Array} tools - Tools dari request
 * @param {Array} toolCalls - Tool calls dari assistant
 * @returns {boolean} True jika valid
 */
export function validateToolCalls(tools, toolCalls) {
    if (!Array.isArray(toolCalls)) return false;
    
    const toolNames = new Set();
    if (Array.isArray(tools)) {
        for (const tool of tools) {
            const name = tool.function?.name || tool.name;
            if (name) toolNames.add(name);
        }
    }
    
    for (const tc of toolCalls) {
        const name = tc.function?.name || tc.name;
        if (!name) return false;
        if (toolNames.size > 0 && !toolNames.has(name)) {
            log.warn(`Tool call to unknown tool: ${name}`);
            return false;
        }
    }
    
    return true;
}