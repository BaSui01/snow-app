import { useCallback, useEffect, useRef, useState } from "react";
import type { FileReviewAnnotationRecord } from "../../../preload";

type ReviewState = {
  key: string;
  records: FileReviewAnnotationRecord[];
  loading: boolean;
  pending: boolean;
  error: string | null;
};

export function useFileReviewAnnotations(sourceKey: string, filePath: string) {
  const key = `${sourceKey}\0${filePath}`;
  const identity = useRef(key);
  identity.current = key;
  const generation = useRef(0);
  const inFlight = useRef<{ key: string; epoch: number } | null>(null);
  const [state, setState] = useState<ReviewState>({
    key,
    records: [],
    loading: true,
    pending: false,
    error: null,
  });

  useEffect(() => {
    const epoch = ++generation.current;
    setState({ key, records: [], loading: true, pending: false, error: null });
    void window.snow
      .listFileReviewAnnotations(sourceKey, filePath)
      .then((records) => {
        if (generation.current === epoch && identity.current === key) {
          setState({
            key,
            records,
            loading: false,
            pending: false,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (generation.current === epoch && identity.current === key) {
          setState({
            key,
            records: [],
            loading: false,
            pending: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      generation.current += 1;
    };
  }, [key, sourceKey, filePath]);

  const run = useCallback(
    async (
      action: () => Promise<FileReviewAnnotationRecord | void>,
      apply: (
        records: FileReviewAnnotationRecord[],
        result: FileReviewAnnotationRecord | void,
      ) => FileReviewAnnotationRecord[],
    ): Promise<boolean> => {
      if (identity.current !== key || inFlight.current?.key === key)
        return false;
      const epoch = generation.current;
      const request = { key, epoch };
      inFlight.current = request;
      setState((previous) =>
        previous.key === key
          ? { ...previous, pending: true, error: null }
          : previous,
      );
      try {
        const result = await action();
        if (generation.current !== epoch || identity.current !== key)
          return false;
        setState((previous) =>
          previous.key === key
            ? {
                ...previous,
                records: apply(previous.records, result),
                pending: false,
              }
            : previous,
        );
        return true;
      } catch (error: unknown) {
        if (generation.current === epoch && identity.current === key) {
          setState((previous) =>
            previous.key === key
              ? {
                  ...previous,
                  pending: false,
                  error: error instanceof Error ? error.message : String(error),
                }
              : previous,
          );
        }
        return false;
      } finally {
        if (inFlight.current === request) inFlight.current = null;
      }
    },
    [key],
  );

  const create = useCallback(
    (anchorJson: string, content: string) =>
      run(
        () =>
          window.snow.createFileReviewAnnotation(
            sourceKey,
            filePath,
            anchorJson,
            content,
          ),
        (records, result) => (result ? [...records, result] : records),
      ),
    [sourceKey, filePath, run],
  );
  const update = useCallback(
    (annotationId: string, content: string) =>
      run(
        () =>
          window.snow.updateFileReviewAnnotation(
            sourceKey,
            filePath,
            annotationId,
            content,
          ),
        (records, result) =>
          result
            ? records.map((item) =>
                item.annotationId === annotationId ? result : item,
              )
            : records,
      ),
    [sourceKey, filePath, run],
  );
  const remove = useCallback(
    (annotationId: string) =>
      run(
        () =>
          window.snow.deleteFileReviewAnnotation(
            sourceKey,
            filePath,
            annotationId,
          ),
        (records) =>
          records.filter((item) => item.annotationId !== annotationId),
      ),
    [sourceKey, filePath, run],
  );

  const visible =
    state.key === key
      ? state
      : { key, records: [], loading: true, pending: false, error: null };
  return { ...visible, create, update, remove };
}
