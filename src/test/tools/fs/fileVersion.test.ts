import * as assert from 'assert';
import { mkdtemp, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getFileVersion, hasVersionConflict } from '../../../tools/fs/fileVersion';

describe('fileVersion', () => {
	it('检测读取后发生的文件修改', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'yunxiao-version-'));
		const file = path.join(dir, 'a.txt');
		await writeFile(file, 'one');
		const version = await getFileVersion(file);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeFile(file, 'two-two');
		assert.strictEqual(await hasVersionConflict(file, version), true);
		assert.strictEqual(await hasVersionConflict(file, undefined), false);
	});
});
