/**
 * git 客户端工厂与仓库检测辅助函数。
 *
 * 各 git 工具通过 GitToolOptions 注入 createClient（测试时可替换为 mock），
 * 默认实现包装 simpleGit(baseDir)。
 */
import simpleGit, { type SimpleGit } from 'simple-git';

/** 创建绑定到指定工作区根的 SimpleGit 客户端。 */
export function createGitClient(workspaceRoot: string): SimpleGit {
	return simpleGit(workspaceRoot);
}

/** 检测指定目录是否为 git 仓库（非仓库或异常均返回 false）。 */
export async function isGitRepo(workspaceRoot: string): Promise<boolean> {
	try {
		return await simpleGit(workspaceRoot).checkIsRepo();
	} catch {
		return false;
	}
}

/** git 工具构造选项（可注入客户端工厂，便于单测）。 */
export interface GitToolOptions {
	/** 可注入的 git 客户端工厂（测试用）。默认用 createGitClient。 */
	readonly createClient?: (workspaceRoot: string) => SimpleGit;
}
