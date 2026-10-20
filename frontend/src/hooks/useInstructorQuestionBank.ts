import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  instructorService,
  type InstructorSimulationGroup,
  type QuestionBankItem,
} from '@/services/instructorService';
import { filterByTitle, paginate } from '@/lib/bankUtils';
import {
  PATIENT_SPECIFIC_TAG,
  normalizeInstructorTags,
  partitionByPatientSpecific,
  replaceItem,
  resolveOrganizationIds,
  type InstructorContentFields,
  type QuestionBankTab,
} from '@/lib/questionBankUtils';

/** Default number of question bank items shown per page. */
const DEFAULT_ITEMS_PER_PAGE = 5;

export interface UseInstructorQuestionBankReturn {
  // data
  items: QuestionBankItem[];
  globalQuestions: QuestionBankItem[];
  patientSpecificQuestions: QuestionBankItem[];
  /** Active tab list after search filtering and pagination. */
  activeItems: QuestionBankItem[];
  /** Number of items in the active tab that match the current search. */
  filteredCount: number;
  totalPages: number;
  currentPage: number;
  /** Distinct user tags across all loaded items, `patient_specific` excluded. */
  allExistingTags: string[];

  // tabs, search, pagination
  tab: QuestionBankTab;
  setTab: (t: QuestionBankTab) => void;
  /** Search query for the active tab; each tab keeps its own value. */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  setPage: (p: number) => void;
  setItemsPerPage: (n: number) => void;

  // organization
  organizationIds: string[];
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string) => void;
  /** True when an organization is resolved, i.e. writes are possible. */
  canCreate: boolean;

  // lifecycle
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;

  // mutations
  createItem: (fields: InstructorContentFields) => Promise<void>;
  updateItem: (id: string, fields: InstructorContentFields) => Promise<void>;
}

/**
 * useInstructorQuestionBank
 *
 * Owns the instructor question bank page's fetch lifecycle, tab/search/pagination
 * state, organization resolution, and the create/update calls. All derivations
 * delegate to the pure helpers in `@/lib/questionBankUtils` and `@/lib/bankUtils`.
 *
 * `GET instructor/question_bank` is tenant-scoped on the server: it returns items
 * from every organization the instructor belongs to (admins: all). The resolved
 * organization is the `organization_id` a newly created item is filed under.
 */
export function useInstructorQuestionBank(): UseInstructorQuestionBankReturn {
  // Loaded data
  const [items, setItems] = useState<QuestionBankItem[]>([]);

  // Tab, per-tab search, pagination
  const [tab, setTabState] = useState<QuestionBankTab>('global');
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [patientSearchQuery, setPatientSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [itemsPerPage, setItemsPerPageState] = useState(DEFAULT_ITEMS_PER_PAGE);

  // Organization resolution
  const [organizationIds, setOrganizationIds] = useState<string[]>([]);
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);

  // Lifecycle
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch the question bank and the instructor's simulation groups together, so a
   * single retry control re-runs both. A question bank failure surfaces as `error`
   * and leaves the previously loaded list in place; a groups failure degrades to
   * zero organizations (create disabled) without touching the list or `error`.
   */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bankResult, groups] = await Promise.all([
        instructorService.getGlobalQuestionBank().then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, error: err })
        ),
        instructorService
          .getSimulationGroups()
          .catch(() => [] as InstructorSimulationGroup[]),
      ]);

      const ids = resolveOrganizationIds(groups);
      setOrganizationIds(ids);
      setActiveOrganizationIdState((previous) => {
        if (ids.length === 0) return null;
        if (previous !== null && ids.includes(previous)) return previous;
        return ids[0];
      });

      if (bankResult.ok) {
        setItems(bankResult.value);
      } else {
        const message =
          bankResult.error instanceof Error
            ? bankResult.error.message
            : 'Failed to load question bank. Please try again.';
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Tab partitioning
  const { global: globalQuestions, patientSpecific: patientSpecificQuestions } = useMemo(
    () => partitionByPatientSpecific(items),
    [items]
  );

  // Tag suggestions across both tabs, with the classification tag excluded
  const allExistingTags = useMemo(
    () =>
      Array.from(
        new Set(
          items.flatMap((item) => item.tags || []).filter((t) => t !== PATIENT_SPECIFIC_TAG)
        )
      ).sort(),
    [items]
  );

  // Active tab derivations: search then paginate
  const searchQuery = tab === 'global' ? globalSearchQuery : patientSearchQuery;
  const tabItems = tab === 'global' ? globalQuestions : patientSpecificQuestions;
  const filteredItems = useMemo(
    () => filterByTitle(tabItems, searchQuery),
    [tabItems, searchQuery]
  );
  const pagination = useMemo(
    () => paginate(filteredItems, page, itemsPerPage),
    [filteredItems, page, itemsPerPage]
  );

  const setTab = useCallback((next: QuestionBankTab) => {
    setTabState(next);
    setPage(1);
  }, []);

  const setSearchQuery = useCallback(
    (q: string) => {
      if (tab === 'global') {
        setGlobalSearchQuery(q);
      } else {
        setPatientSearchQuery(q);
      }
      setPage(1);
    },
    [tab]
  );

  const setItemsPerPage = useCallback((n: number) => {
    setItemsPerPageState(n);
    setPage(1);
  }, []);

  const setActiveOrganizationId = useCallback((id: string) => {
    setActiveOrganizationIdState(id);
  }, []);

  /**
   * Create an item under the resolved organization. Tags are normalized against
   * the active tab, so an item created from the patient-specific tab carries
   * `patient_specific` and one created from the group-wide tab never does.
   * Returns without calling the service while no organization is resolved.
   * Failures propagate so the caller can keep the dialog open and report them.
   */
  const createItem = useCallback(
    async (fields: InstructorContentFields) => {
      if (activeOrganizationId === null) return;
      const tags = normalizeInstructorTags(fields.tags, tab === 'patientSpecific');
      const created = await instructorService.createQuestionBankQuestion(
        activeOrganizationId,
        {
          title: fields.title,
          question_text: fields.question_text,
          clinical_intent: fields.clinical_intent,
          evaluation_criteria: fields.evaluation_criteria,
          is_mandatory: fields.is_mandatory,
          tags,
        }
      );
      setItems((previous) => [created, ...previous]);
    },
    [activeOrganizationId, tab]
  );

  /**
   * Update an item in place. Tags are normalized against the item's own
   * `patient_specific` membership rather than the active tab, so an edit can
   * never silently move an item between tabs. Failures propagate so the caller
   * can stay in edit mode with the entered values.
   */
  const updateItem = useCallback(
    async (id: string, fields: InstructorContentFields) => {
      const existing = items.find((item) => item.id === id);
      const patientSpecific = (existing?.tags || []).includes(PATIENT_SPECIFIC_TAG);
      const tags = normalizeInstructorTags(fields.tags, patientSpecific);
      const updated = await instructorService.updateQuestionBankQuestion(id, {
        title: fields.title,
        question_text: fields.question_text,
        clinical_intent: fields.clinical_intent,
        evaluation_criteria: fields.evaluation_criteria,
        is_mandatory: fields.is_mandatory,
        tags,
      });
      setItems((previous) => replaceItem(previous, updated));
    },
    [items]
  );

  return {
    // data
    items,
    globalQuestions,
    patientSpecificQuestions,
    activeItems: pagination.items,
    filteredCount: filteredItems.length,
    totalPages: pagination.totalPages,
    currentPage: pagination.currentPage,
    allExistingTags,

    // tabs, search, pagination
    tab,
    setTab,
    searchQuery,
    setSearchQuery,
    setPage,
    setItemsPerPage,

    // organization
    organizationIds,
    activeOrganizationId,
    setActiveOrganizationId,
    canCreate: activeOrganizationId !== null,

    // lifecycle
    loading,
    error,
    reload,

    // mutations
    createItem,
    updateItem,
  };
}
