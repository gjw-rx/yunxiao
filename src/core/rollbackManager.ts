/**
 * RollbackManager -- 协调对话回退与文件操作回退。
 *
 * 接收云端回退 API 返回的文件操作列表，对 code.edit 执行反向 diff 应用
 * （交换 oldString/newString），对不可逆工具收集为提示列表。
 * 反向应用前检查文件当前内容是否包含 newString，不包含则跳过并加入冲突列表。
 */
import * as path from 'path';
import * as vscode from 'vscode';

import type { AIClient, FileOperation, RollbackApiResponse } from '../aiClient';

/** 单次回退的整体结果。 */
export interface RollbackResult {
	/** 云端回退的轮次列表。 */
	rolled_back_turns: number[];
	/** 成功反向应用的文件操作。 */
	applied: FileOperation[];
	/** 文件版本冲突，跳过的文件操作。 */
	conflicts: FileOperation[];
	/** 不可逆工具操作（无法自动回退）。 */
	non_reversible: string[];
}

export class RollbackManager {
	constructor(private readonly client: AIClient) {}

	/**
	 * 请求回退并执行文件回退。
	 *
	 * @param sessionId 会话 ID。
	 * @param targetTurn 目标轮次（1-based）。
	 * @returns 回退结果。
	 */
	async requestRollback(sessionId: string, targetTurn: number): Promise<RollbackResult> {
		const apiResponse: RollbackApiResponse = await this.client.rollback(sessionId, targetTurn);

		const { applied, conflicts } = await this.applyFileRollback(apiResponse.file_operations);

		return {
			rolled_back_turns: apiResponse.rolled_back_turns,
			applied,
			conflicts,
			non_reversible: apiResponse.non_reversible_tools,
		};
	}

	/**
	 * 对文件操作列表执行反向应用。
	 *
	 * 逆序遍历操作（最后执行的先回退），对 code.edit 交换 oldString/newString。
	 * 文件版本不匹配时跳过并加入冲突列表。
	 *
	 * @param operations 文件操作列表。
	 * @returns 应用结果与冲突列表。
	 */
	private async applyFileRollback(
		operations: FileOperation[],
	): Promise<{ applied: FileOperation[]; conflicts: FileOperation[] }> {
		const applied: FileOperation[] = [];
		const conflicts: FileOperation[] = [];

		// 逆序遍历（最后执行的先回退）
		const reversed = [...operations].reverse();

		for (const op of reversed) {
			if (!op.reversible || op.tool !== 'code.edit') {
				continue;
			}

			if (!op.path || !op.old_string || !op.new_string) {
				continue;
			}

			const success = await this.reverseCodeEdit(op.path, op.old_string, op.new_string);
			if (success) {
				applied.push(op);
			} else {
				conflicts.push(op);
			}
		}

		return { applied, conflicts };
	}

	/**
	 * 反向应用一次 code.edit：将文件中的 newString 替换回 oldString。
	 *
	 * @param filePath 文件相对路径。
	 * @param oldString 编辑前的原始内容。
	 * @param newString 编辑后的新内容。
	 * @returns 是否成功应用。
	 */
	private async reverseCodeEdit(
		filePath: string,
		oldString: string,
		newString: string,
	): Promise<boolean> {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			return false;
		}

		const absPath = path.resolve(workspaceRoot, filePath);
		const uri = vscode.Uri.file(absPath);

		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const content = doc.getText();

			// 检查文件是否包含 newString（即编辑后的内容）
			if (!content.includes(newString)) {
				return false;
			}

			// 反向替换：newString -> oldString
			const newContent = content.replace(newString, oldString);
			if (newContent === content) {
				return false;
			}

			const edit = new vscode.WorkspaceEdit();
			const fullRange = new vscode.Range(
				doc.positionAt(0),
				doc.positionAt(content.length),
			);
			edit.replace(uri, fullRange, newContent);
			const success = await vscode.workspace.applyEdit(edit);
			if (!success) {
				return false;
			}

			await doc.save();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 获取工作区根目录。
	 *
	 * @returns 工作区根目录路径，无打开的工作区时返回 null。
	 */
	private getWorkspaceRoot(): string | null {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return null;
		}
		return folders[0].uri.fsPath;
	}
}
