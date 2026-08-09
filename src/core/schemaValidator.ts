/**
 * 轻量 JSON Schema 校验器 - 工具参数的运行时校验。
 * 支持子集:type/required/properties/items/enum/minimum/maximum/minLength/maxLength/additionalProperties。
 * 对未知关键字保守放行,避免误伤未来扩展的 schema。
 * 在工具注册时编译一次,调用时复用,避免每次调用重复解析。
 */
import * as logger from '../logger';

/** JSON Schema 节点(校验器支持的子集;未知关键字透传忽略)。 */
interface SchemaNode {
	type?: string | readonly string[];
	required?: readonly string[];
	properties?: Readonly<Record<string, SchemaNode>>;
	items?: SchemaNode;
	enum?: readonly unknown[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	additionalProperties?: boolean;
	[key: string]: unknown;
}

/** 校验单个值的类型,通过返回 null,否则返回错误描述。 */
function checkType(value: unknown, expected: string): string | null {
	const actual = typeof value;
	switch (expected) {
		case 'integer':
			return actual === 'number' && Number.isInteger(value) ? null : `期望 integer，实际 ${actual}`;
		case 'number':
			return actual === 'number' ? null : `期望 number，实际 ${actual}`;
		case 'string':
			return actual === 'string' ? null : `期望 string，实际 ${actual}`;
		case 'boolean':
			return actual === 'boolean' ? null : `期望 boolean，实际 ${actual}`;
		case 'array':
			return Array.isArray(value) ? null : `期望 array，实际 ${actual}`;
		case 'object':
			return value !== null && actual === 'object' && !Array.isArray(value)
				? null
				: `期望 object，实际 ${actual}`;
		case 'null':
			return value === null ? null : `期望 null，实际 ${actual}`;
		default:
			// 未知类型:保守放行,由后续关键字决定
			return null;
	}
}

/** 递归校验一个值是否符合 schema 节点,错误追加到 errors(带字段路径)。 */
function validateNode(
	node: SchemaNode,
	value: unknown,
	fieldPath: string,
	errors: string[],
): void {
	// type 检查(支持数组形式如 ['string', 'null'])
	if (node.type !== undefined && value !== undefined) {
		const types = Array.isArray(node.type) ? node.type : [node.type];
		const matched = types.some((t) => checkType(value, t) === null);
		if (!matched) {
			errors.push(`${fieldPath} 类型不符:期望 ${types.join(' | ')}，实际 ${typeof value}`);
			return;
		}
	}

	// enum
	if (node.enum !== undefined && !node.enum.some((e) => e === value)) {
		errors.push(`${fieldPath} 不在允许的枚举值中:${JSON.stringify(node.enum)}`);
		return;
	}

	// 数字边界
	if (typeof value === 'number') {
		if (node.minimum !== undefined && value < node.minimum) {
			errors.push(`${fieldPath} 小于最小值 ${node.minimum}`);
		}
		if (node.maximum !== undefined && value > node.maximum) {
			errors.push(`${fieldPath} 大于最大值 ${node.maximum}`);
		}
	}

	// 字符串长度
	if (typeof value === 'string') {
		if (node.minLength !== undefined && value.length < node.minLength) {
			errors.push(`${fieldPath} 长度小于 ${node.minLength}`);
		}
		if (node.maxLength !== undefined && value.length > node.maxLength) {
			errors.push(`${fieldPath} 长度大于 ${node.maxLength}`);
		}
	}

	// 数组元素
	if (Array.isArray(value) && node.items !== undefined) {
		value.forEach((item, index) => {
			validateNode(node.items!, item, `${fieldPath}[${index}]`, errors);
		});
	}

	// 对象属性
	if (value !== null && typeof value === 'object' && !Array.isArray(value) && node.properties) {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(node.properties)) {
			if (obj[key] !== undefined) {
				validateNode(node.properties[key], obj[key], `${fieldPath}.${key}`, errors);
			}
		}
	}
}

/**
 * 编译参数校验器:输入工具 schema 的 parameters(JSON Schema),
 * 返回 (args) => string[](错误列表,空数组 = 通过)。
 * @param parameters 工具声明的参数 JSON Schema
 * @returns 校验函数,入参为实际调用参数,出参为错误描述列表
 */
export function compileValidator(
	parameters: Record<string, unknown>,
): (args: Record<string, unknown>) => string[] {
	const schema = parameters as SchemaNode;
	logger.log('[SchemaValidator] 编译参数校验器 properties=' + Object.keys(schema.properties ?? {}).join(','));

	return (args: Record<string, unknown>): string[] => {
		const errors: string[] = [];

		// 顶层对象类型检查
		if (schema.type !== undefined && schema.type !== 'object' && checkType(args, String(schema.type)) !== null) {
			errors.push(`顶层参数应为 ${schema.type}`);
			return errors;
		}

		// 必填字段
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (args[key] === undefined) {
					errors.push(`缺少必填参数 ${key}`);
				}
			}
		}

		// 属性校验
		if (schema.properties) {
			for (const key of Object.keys(schema.properties)) {
				if (args[key] !== undefined) {
					validateNode(schema.properties[key], args[key], key, errors);
				}
			}
		}

		// 禁止未声明属性
		if (schema.additionalProperties === false) {
			const known = new Set([...(schema.required ?? []), ...Object.keys(schema.properties ?? {})]);
			for (const key of Object.keys(args)) {
				if (!known.has(key)) {
					errors.push(`包含未声明的参数 ${key}`);
				}
			}
		}

		return errors;
	};
}
