import { ConfigKey, Global } from '../common/global';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CodeUtil } from '../common/codeUtil';
import { Out } from '../common/out';
import { Script, Method, Ref, Label, Hotkey, Block, Variable } from './model';

export interface BuildScriptOptions {
    /** Defaults to false. If true, short-circuits when document is in cache. */
    usingCache?: boolean;
    /** Lines to parse. Defaults to extension setting. -1 for unlimited parsing. 0 for no parsing. */
    maximumParseLength?: number;
}

export class Parser {
    private static documentCache = new Map<string, Script>();

    /**
     * load method list by path
     * @param buildPath
     */
    public static async buildByPath(buildPath: string) {
        if (!buildPath) {
            return;
        }
        if (fs.statSync(buildPath).isDirectory()) {
            fs.readdir(buildPath, (err, files) => {
                if (err) {
                    Out.log(err);
                    return;
                }
                for (const file of files) {
                    if (file.match(/(^\.|out|target|node_modules)/)) {
                        continue;
                    }
                    this.buildByPath(buildPath + '/' + file);
                }
            });
        } else if (buildPath.match(/\b(ahk|ext)$/i)) {
            const document = await vscode.workspace.openTextDocument(
                vscode.Uri.file(buildPath),
            );
            this.buildScript(document);
        }
    }

    /**
     * Parse the document into a Script and add it to the cache
     * @param document
     */
    public static async buildScript(
        document: vscode.TextDocument,
        options: BuildScriptOptions = {},
    ): Promise<Script> {
        if (options.usingCache && this.documentCache.get(document.uri.path)) {
            return this.documentCache.get(document.uri.path);
        }

        const maxParseLength =
            options.maximumParseLength ??
            Global.getConfig<number>(ConfigKey.maximumParseLength);
        // limit parse length for performance
        /** Count of lines to parse */
        const linesToParse =
            maxParseLength >= 0
                ? Math.min(document.lineCount, maxParseLength)
                : document.lineCount;

        const methods: Method[] = [];
        const refs: Ref[] = [];
        const labels: Label[] = [];
        const hotkeys: Hotkey[] = [];
        const variables: Variable[] = [];
        const blocks: Block[] = [];
        let currentMethod: Method;
        let deep = 0;
        let blockComment = false;
        for (let line = 0; line < linesToParse; line++) {
            const lineText = document.lineAt(line).text;
            if (lineText.match(startBlockComment)) {
                blockComment = true;
            }
            if (lineText.match(endBlockComment)) {
                blockComment = false;
            }
            if (blockComment) {
                continue;
            }
            const methodOrRef = Parser.detectMethodByLine(document, line);
            if (methodOrRef) {
                if (methodOrRef instanceof Method) {
                    methods.push(methodOrRef);
                    refs.push(
                        new Ref(
                            methodOrRef.name,
                            document,
                            line,
                            methodOrRef.character,
                        ),
                    );
                    currentMethod = methodOrRef;
                    if (methodOrRef.withQuote) {
                        deep++;
                    }
                    continue;
                } else {
                    CodeUtil.join(refs, methodOrRef);
                }
            }
            const label = Parser.getLabelByLine(document, line);
            if (label) {
                labels.push(label);
                continue;
            }
            const hotkey = Parser.getHotkeyByLine(document, line);
            if (hotkey) {
                hotkeys.push(hotkey);
                continue;
            }
            const block = Parser.getBlockByLine(document, line);
            if (block) {
                blocks.push(block);
            }
            if (lineText.includes('{')) {
                deep++;
            }
            if (lineText.includes('}')) {
                deep--;
                if (currentMethod) {
                    currentMethod.endLine = line;
                }
            }
            const variable = Parser.detectVariableByLine(document, line);
            if (variable) {
                if (deep === 0 || !currentMethod) {
                    this.joinVars(variables, variable);
                } else {
                    currentMethod.pushVariable(variable);
                }
            }
        }
        const script: Script = {
            methods,
            labels,
            hotkeys,
            refs,
            variables,
            blocks,
        };
        this.documentCache.set(document.uri.path, script);
        return script;
    }

    public static async getMethodByName(
        document: vscode.TextDocument,
        name: string,
    ) {
        name = name.toLowerCase();
        for (const method of this.documentCache.get(document.uri.path)
            .methods) {
            if (method.name.toLowerCase() === name) {
                return method;
            }
        }
        for (const filePath of this.documentCache.keys()) {
            for (const method of this.documentCache.get(filePath).methods) {
                if (method.name.toLowerCase() === name) {
                    return method;
                }
            }
        }
        return undefined;
    }

    public static async getAllMethod(): Promise<Method[]> {
        const methods = [];
        for (const filePath of this.documentCache.keys()) {
            for (const method of this.documentCache.get(filePath).methods) {
                methods.push(method);
            }
        }
        return methods;
    }

    public static async getHotkeyByName(
        document: vscode.TextDocument,
        name: string,
    ) {
        name = name.toLowerCase();
        for (const hotkey of this.documentCache.get(document.uri.path)
            .hotkeys) {
            // remove hotstring's leading colons with options (:*:btw) from name
            const hotkeyName = hotkey.name.toLowerCase().replace(/^:.*?:/, '');
            if (hotkeyName === name) {
                return hotkey;
            }
        }
        return undefined;
    }

    public static async getLabelByName(
        document: vscode.TextDocument,
        name: string,
    ) {
        name = name.toLowerCase();
        for (const label of this.documentCache.get(document.uri.path).labels) {
            if (label.name.toLowerCase() === name) {
                return label;
            }
        }
        for (const filePath of this.documentCache.keys()) {
            for (const label of this.documentCache.get(filePath).labels) {
                if (label.name.toLowerCase() === name) {
                    return label;
                }
            }
        }
        return undefined;
    }

    public static getAllRefByName(name: string): Ref[] {
        const refs = [];
        name = name.toLowerCase();
        for (const filePath of this.documentCache.keys()) {
            const document = this.documentCache.get(filePath);
            for (const ref of document.refs) {
                if (ref.name.toLowerCase() === name) {
                    refs.push(ref);
                }
            }
        }
        return refs;
    }

    private static getBlockByLine(
        document: vscode.TextDocument,
        line: number,
    ): Block {
        const { text } = document.lineAt(line);
        const blockMatch = text.match(/;;(.+)/);
        if (blockMatch) {
            return {
                document,
                line,
                name: blockMatch[1],
                character: text.indexOf(blockMatch[1]),
            };
        }
        return undefined;
    }

    private static getHotkeyByLine(
        document: vscode.TextDocument,
        line: number,
    ) {
        const text = CodeUtil.purify(document.lineAt(line).text).trim();
        // captures hotkeys and hotstrings
        const hotkey = /^(.+?)::|hotkey(?:\s|,)\s*(?!\s*if)([^,]+)/i.exec(text);
        if (hotkey) {
            const hotkeyName = hotkey[1] ?? hotkey[2];
            return new Hotkey(
                hotkeyName,
                document,
                line,
                text.indexOf(hotkeyName),
            );
        }
        return undefined;
    }

    private static getLabelByLine(document: vscode.TextDocument, line: number) {
        const text = CodeUtil.purify(document.lineAt(line).text);
        // [\u4e00-\u9fa5] Chinese unicode characters
        const label = /^[ \t]*([\u4e00-\u9fa5_a-zA-Z0-9]+):{1}(?!(:|=))/.exec(
            text,
        );
        if (label) {
            const labelName = label[1];
            if (
                labelName.toLowerCase() === 'case' ||
                labelName.toLowerCase() === 'default'
            ) {
                return undefined;
            }
            return new Label(
                labelName,
                document,
                line,
                text.indexOf(labelName),
            );
        }
        return undefined;
    }

    private static varDefPattern =
        /[ \t]*(\w+?)\s*([+\-*/.:])?(?<![=!])=(?![=!]).+/;
    private static varCommandPattern = /(\w+)[ \t,]+/g;
    private static keywords = ['and', 'or', 'new', 'extends', 'if', 'loop'];
    private static detectVariableByLine(
        document: vscode.TextDocument,
        line: number,
    ): Variable | Variable[] {
        const lineText = CodeUtil.purify(document.lineAt(line).text);

        const defMatch = lineText.match(Parser.varDefPattern);
        if (defMatch) {
            const varName = defMatch[1];
            return {
                line,
                document,
                isGlobal: true,
                method: null,
                name: varName,
                character: lineText.indexOf(varName),
            };
        } else {
            const vars = [];
            const commandMatchAll = CodeUtil.matchAll(
                Parser.varCommandPattern,
                lineText.replace(/\(.+?\)/g, ''),
            );
            for (let index = 0; index < commandMatchAll.length; index++) {
                if (index === 0) {
                    continue;
                }
                const varName = commandMatchAll[index][1];
                if (this.keywords.includes(varName.toLowerCase())) {
                    continue;
                }
                vars.push({
                    line,
                    document,
                    isGlobal: true,
                    method: null,
                    name: varName,
                    character: lineText.indexOf(commandMatchAll[index][0]),
                });
            }
            return vars;
        }
    }

    /**
     * detect method by line
     * @param document
     * @param line
     */
    private static detectMethodByLine(
        document: vscode.TextDocument,
        line: number,
        origin?: string,
    ): Method | Ref | Ref[] {
        origin ??= document.lineAt(line).text;
        const text = CodeUtil.purify(origin);
        // [\u4e00-\u9fa5] Chinese unicode characters
        const refPattern =
            /\s*(([\u4e00-\u9fa5_a-zA-Z0-9]+)(?<!if|while)\(.*?\))\s*(\{)?\s*/i;
        const methodMatch = text.match(refPattern);
        if (!methodMatch) {
            return undefined;
        }
        const methodName = methodMatch[2];
        const character = origin.indexOf(methodName);
        if (text.length !== methodMatch[0].length) {
            const refs = [new Ref(methodName, document, line, character)];
            const newRef = this.detectMethodByLine(
                document,
                line,
                origin.replace(new RegExp(methodName + '\\s*\\('), ''),
            );
            CodeUtil.join(refs, newRef);
            return refs;
        }
        const methodFullName = methodMatch[1];
        const isMethod = methodMatch[3];
        if (isMethod) {
            return new Method(
                methodFullName,
                methodName,
                document.uri.toString(),
                line,
                character,
                true,
                Parser.getRemarkByLine(document, line - 1),
            );
        }
        for (let i = line + 1; i < document.lineCount; i++) {
            const nextLineText = CodeUtil.purify(document.lineAt(i).text);
            if (!nextLineText.trim()) {
                continue;
            }
            if (nextLineText.match(/^\s*{/)) {
                return new Method(
                    methodFullName,
                    methodName,
                    document.uri.toString(),
                    line,
                    character,
                    false,
                    Parser.getRemarkByLine(document, line - 1),
                );
            } else {
                return new Ref(methodName, document, line, character);
            }
        }
        return undefined;
    }

    /**
     * detect remark, remark format: ;any
     * @param document
     * @param line
     */
    private static getRemarkByLine(
        document: vscode.TextDocument,
        line: number,
    ) {
        if (line >= 0) {
            const { text } = document.lineAt(line);
            const markMatch = text.match(/^\s*;\s*(.+)/);
            if (markMatch) {
                return markMatch[1];
            }
        }
        return null;
    }

    public static joinVars(
        variables: Variable[],
        items: Variable | Variable[],
    ) {
        if (!variables || !items) {
            return;
        }

        if (!Array.isArray(items)) {
            items = [items];
        }

        loop: for (const item of items) {
            for (const variable of variables) {
                if (variable.name === item.name) {
                    continue loop;
                }
            }
            variables.push(item);
        }
    }
}

const startBlockComment = / *\/\*/;
const endBlockComment = / *\*\//;
