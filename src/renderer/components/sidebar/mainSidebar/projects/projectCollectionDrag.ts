/** 合集拖拽排序使用的 DataTransfer 类型：与项目行拖拽（text/plain）区分。 */
export const PROJECT_COLLECTION_DRAG_TYPE =
  "application/x-snow-project-collection";

/** dragover 阶段只能读 types，据此判断当前拖拽是否来自合集行。 */
export function isProjectCollectionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PROJECT_COLLECTION_DRAG_TYPE);
}
