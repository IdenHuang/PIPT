import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { UI_COLORS } from '@/lib/colors';
import type { GlobalRubricQuestion } from '@/services/instructorService';

export interface RubricSectionProps {
  questions: GlobalRubricQuestion[];
  selectedQuestionId: string | null;
  onSelectQuestion: (id: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSaveQuestion: () => Promise<void> | void;
  onDeleteQuestion?: () => void;
  onUpdateField: (field: keyof GlobalRubricQuestion, value: string | boolean) => void;
}

export function RubricSection({
  questions,
  selectedQuestionId,
  onSelectQuestion,
  searchQuery,
  onSearchChange,
  onSaveQuestion,
  onDeleteQuestion,
  onUpdateField,
}: RubricSectionProps) {
  const selectedQuestion = questions.find(q => q.id === selectedQuestionId);

  const filteredQuestions = questions.filter(q =>
    q.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  //remove duplicate questions based on id
  const uniqueQuestions = Array.from(
    new Map(filteredQuestions.map(question => [question.id, question])).values()
  );

  return (
    <div className="flex h-full relative">
      {/* Question List Sidebar */}
      <aside
        className="flex flex-col border-r overflow-y-auto"
        style={{
          backgroundColor: UI_COLORS.background.white,
          borderRightWidth: '1px',
          borderRightStyle: 'solid',
          borderRightColor: UI_COLORS.border.default,
          width: '20rem',
          minWidth: '20rem',
        }}
      >
        {/* Header */}
        <div style={{ borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: UI_COLORS.border.default }}>
          <div className="px-6 pt-6 pb-6">
            <h2 className="font-semibold text-lg mb-3" style={{ color: UI_COLORS.text.heading }}>
              GROUP-WIDE KEY QUESTIONS
            </h2>
            <p className="text-xs mb-4" style={{ color: UI_COLORS.text.muted }}>
              These questions apply to all patients in this simulation group.
              Group-wide key questions can only be edited here.
            </p>
            <p className="text-xs mb-4" style={{ color: UI_COLORS.text.muted }}>
              In each patient&apos;s page, group-wide key questions are view-only.
            </p>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: UI_COLORS.text.muted }} />
              <Input
                placeholder="Search Group-Wide Key Questions"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="pl-9 py-2 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
                style={{
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: UI_COLORS.border.default,
                  backgroundColor: UI_COLORS.background.white
                }}
              />
            </div>
          </div>
        </div>

        {/* Question List */}
        <div className="flex-1 overflow-y-auto">
          {uniqueQuestions.map((question, idx) => (
            console.log(question),
            <button
              key={question.id}
              onClick={() => onSelectQuestion(question.id)}
              className="w-full text-left py-3 transition-colors"
              style={{
                backgroundColor: selectedQuestionId === question.id ? UI_COLORS.background.tableHeader : 'transparent',
                borderBottomWidth: '1px',
                borderBottomStyle: 'solid',
                borderBottomColor: UI_COLORS.border.default,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (selectedQuestionId !== question.id) {
                  e.currentTarget.style.backgroundColor = UI_COLORS.background.hoverLight;
                }
              }}
              onMouseLeave={(e) => {
                if (selectedQuestionId !== question.id) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <div className="px-6">
                <p className="text-sm font-medium mb-1" style={{ color: UI_COLORS.text.heading }}>
                  Q{idx + 1} - {question.title}
                </p>
                <p className="text-xs" style={{ color: UI_COLORS.text.muted }}>
                  [{question.required ? 'Required' : 'Optional'}]
                </p>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Question Detail Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-8">
          {selectedQuestion ? (
            <div className="max-w-4xl space-y-6">
              <h2 className="text-2xl font-bold" style={{ color: UI_COLORS.text.heading }}>
                Question {filteredQuestions.findIndex(q => q.id === selectedQuestionId) + 1}
              </h2>

              {/* Title */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                  Title
                </label>
                <Input
                  value={selectedQuestion.title}
                  onChange={(e) => onUpdateField('title', e.target.value)}
                  className="w-full py-3 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    backgroundColor: UI_COLORS.background.white
                  }}
                />
              </div>

              {/* Key Question */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                  Key Question
                </label>
                <textarea
                  value={selectedQuestion.keyQuestion}
                  onChange={(e) => onUpdateField('keyQuestion', e.target.value)}
                  className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    outlineColor: UI_COLORS.border.medium,
                    minHeight: '100px',
                  }}
                />
              </div>

              {/* Clinical Intent */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                  Clinical Intent
                </label>
                <textarea
                  value={selectedQuestion.clinicalIntent}
                  onChange={(e) => onUpdateField('clinicalIntent', e.target.value)}
                  className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    outlineColor: UI_COLORS.border.medium,
                    minHeight: '100px',
                  }}
                />
              </div>

              {/* Evaluation Criteria */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: UI_COLORS.text.body }}>
                  Evaluation Criteria
                </label>
                <textarea
                  value={selectedQuestion.evaluationCriteria}
                  onChange={(e) => onUpdateField('evaluationCriteria', e.target.value)}
                  className="w-full px-3 py-3 rounded-lg resize-none focus:outline-none focus:ring-2 text-base"
                  style={{
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: UI_COLORS.border.default,
                    outlineColor: UI_COLORS.border.medium,
                    minHeight: '150px',
                  }}
                />
              </div>

              {/* Required Toggle */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={selectedQuestion.required}
                  onClick={() => onUpdateField('required', !selectedQuestion.required)}
                  className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{
                    backgroundColor: selectedQuestion.required ? UI_COLORS.toggle.active : UI_COLORS.toggle.inactive
                  }}
                >
                  <span
                    className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
                    style={{
                      transform: selectedQuestion.required ? 'translateX(22px)' : 'translateX(2px)'
                    }}
                  />
                </button>
                <span className="text-sm font-medium" style={{ color: UI_COLORS.text.body }}>
                  Required for Case Completion
                </span>
              </div>

              {/* Action Buttons (shown when onSaveQuestion or onDeleteQuestion provided) */}
              {(onSaveQuestion !== undefined || onDeleteQuestion !== undefined) && (
                <div className="flex items-center gap-4 pt-4">
                  {onSaveQuestion && (
                    <Button
                      onClick={onSaveQuestion}
                      className="px-8 py-3 text-base font-medium transition-colors"
                      style={{
                        backgroundColor: UI_COLORS.button.primary,
                        color: UI_COLORS.button.text
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primaryHover}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = UI_COLORS.button.primary}
                    >
                      Save Changes
                    </Button>
                  )}

                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full" style={{ color: UI_COLORS.text.light }}>
              <p>Select a question to edit or create a new one</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
