import * as assert from 'assert';
import { compileValidator } from '../../core/schemaValidator';

describe('SchemaValidator', () => {
	const toolParams = {
		type: 'object',
		properties: {
			path: { type: 'string' },
			offset: { type: 'integer', minimum: 1 },
			mode: { type: 'string', enum: ['file', 'dir', 'all'] },
			recursive: { type: 'boolean' },
			tags: { type: 'array', items: { type: 'string' } },
			meta: { type: 'object', properties: { name: { type: 'string' } } },
		},
		required: ['path'],
	};

	it('合法参数通过校验', () => {
		const validate = compileValidator(toolParams);
		assert.deepStrictEqual(validate({ path: 'a.ts', offset: 2, recursive: true }), []);
	});

	it('缺失必填参数报错', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({});
		assert.ok(errors.some((e) => e.includes('缺少必填参数 path')));
	});

	it('类型错误报错（offset 传字符串）', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', offset: 'abc' });
		assert.ok(errors.some((e) => e.includes('offset') && e.includes('integer')));
	});

	it('integer 拒绝小数', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', offset: 1.5 });
		assert.ok(errors.some((e) => e.includes('offset')));
	});

	it('数字边界校验（minimum）', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', offset: 0 });
		assert.ok(errors.some((e) => e.includes('offset') && e.includes('最小值')));
	});

	it('枚举校验', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', mode: 'unknown' });
		assert.ok(errors.some((e) => e.includes('枚举')));
	});

	it('数组元素校验（items）', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', tags: [1, 2] });
		assert.ok(errors.some((e) => e.includes('tags[0]')));
	});

	it('嵌套对象属性校验', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', meta: { name: 42 } });
		assert.ok(errors.some((e) => e.includes('meta.name')));
	});

	it('additionalProperties:false 拒绝未声明参数', () => {
		const validate = compileValidator({
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
			additionalProperties: false,
		});
		const errors = validate({ path: 'a.ts', extra: 1 });
		assert.ok(errors.some((e) => e.includes('未声明的参数 extra')));
	});

	it('未知关键字保守放行（不报错）', () => {
		const validate = compileValidator({
			type: 'object',
			properties: { path: { type: 'string', format: 'file-path' } },
			required: ['path'],
		});
		assert.deepStrictEqual(validate({ path: 'a.ts' }), []);
	});

	it('null 值不被判为缺失必填', () => {
		const validate = compileValidator(toolParams);
		const errors = validate({ path: 'a.ts', mode: null });
		assert.ok(errors.some((e) => e.includes('mode')));
	});
});
