/**
 * Handlists — the type-matched picker
 *
 * The one control that puts things INTO a handlist, wherever the
 * gesture starts. A selection on the search page saves a whole ticked
 * set; a record's own page adds itself alone. Both are the same
 * question — which handlist? — so both ask it through this component
 * rather than through two menus that would drift apart.
 *
 * TYPE-MATCHED, ALWAYS. A handlist holds one kind of thing, and its
 * kind is fixed by its first member. The list this offers is therefore
 * not "your handlists" but "the handlists this could go in": the
 * resource route answers the `targets` intent with the ones this person
 * may write to whose type matches or is not yet fixed. Offering a
 * mismatched handlist and refusing on submit is exactly the failure the
 * type rule exists to prevent, so the refusal happens before the click.
 *
 * NEW HANDLIST, NAMED. The last option opens a name field, because
 * naming is required at creation — there is no "Untitled" in this
 * model. The confirm button says which of the two things it will do.
 *
 * WHAT IT REPORTS. Never a bare "Added". A confirmed add states the
 * resulting count and the handlist it landed in, and adds the "N
 * already in" line whenever duplicates were among the members —
 * duplicates are no-ops, and a count that hid them would be a count
 * that lied. A refusal renders the reason the server gave (type
 * mismatch, ceiling, duplicate name, missing name) rather than a
 * generic failure.
 *
 * MEMBERS MAY ARRIVE LATE. `memberIds` is nullable so a host that has
 * to resolve its set server-side first — the search page's "all
 * matching" selection, which is a promise about a query rather than a
 * list in the browser — can open the dialog immediately and fill it in
 * when the ids land. `onOpen` is where that host starts the work, and
 * `resolveError` is where it reports that the set could not be taken.
 *
 * The dialog is the house shell (`DismissDialog`'s scrim, box, serif
 * title and 44px buttons), not a fork of it: this one carries a list
 * and a name field, which that component has no room for.
 *
 * Copy lives in the `handlists` namespace, which owns every string this
 * renders; the trigger's own label comes from the caller, because the
 * two call sites name the gesture differently.
 *
 * @version v0.7.0
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Check, ListChecks, ListPlus, Plus } from "lucide-react";
import { useFormatters } from "~/lib/use-formatters";

/** records · entities · places, in the vocabulary the search tabs use. */
export type HandlistPickerType = "records" | "entities" | "places";

/** One handlist the add menu may offer, as the resource route lists it. */
interface HandlistTarget {
  id: string;
  name: string;
  total: number;
  /** How many of the members about to be added it already holds. */
  alreadyIn: number;
}

/** The `targets` intent's answer. */
type TargetsResponse =
  | { ok: true; targets: HandlistTarget[] }
  | { ok: false; error: string };

/** The add's answer: the resulting count, or the reason it did not. */
type AddResponse =
  | {
      ok: true;
      id: string;
      name: string;
      added: number;
      alreadyIn: number;
      total: number;
      warn?: boolean;
    }
  | { ok: false; error: string };

/** What a caller hears back once an add has landed. */
export interface HandlistAddOutcome {
  id: string;
  name: string;
  added: number;
  alreadyIn: number;
  total: number;
}

/** The resource route every intent posts to; it owns all three verbs. */
const ADD_ROUTE = "/handlists/add";

/** Server refusal codes, each with the string that explains it. */
const ERROR_KEYS: Record<string, string> = {
  "type-mismatch": "pickerErrorTypeMismatch",
  ceiling: "pickerErrorCeiling",
  "duplicate-name": "pickerErrorDuplicateName",
  "name-required": "pickerErrorNameRequired",
};

export function HandlistPicker({
  recordType,
  memberIds,
  triggerLabel,
  intent = "add",
  holdingCount = 0,
  triggerClassName,
  resolveError = null,
  onOpen,
  onDone,
}: {
  recordType: HandlistPickerType;
  /** The members to add; null while the caller is still resolving them. */
  memberIds: string[] | null;
  triggerLabel: string;
  /** `save` for a selection, `add` for one record — it picks the title. */
  intent?: "save" | "add";
  /**
   * How many handlists this person can reach already hold this record.
   * Past zero the trigger states it instead of only offering the
   * action, so a reader learns where the record is without opening
   * anything. Omitted where the answer is not one record's to give.
   */
  holdingCount?: number;
  triggerClassName?: string;
  /** The caller could not resolve its members; shown instead of the list. */
  resolveError?: string | null;
  /** Fired when the trigger opens the dialog, before the members exist. */
  onOpen?: () => void;
  /** Fired once an add has landed, with what it landed as. */
  onDone?: (outcome: HandlistAddOutcome) => void;
}) {
  const { t } = useTranslation("handlists");
  const { formatNumber } = useFormatters();

  const [open, setOpen] = useState(false);
  /** The chosen target id, or `new` while the name field is showing. */
  const [choice, setChoice] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  /**
   * Whether THIS opening has posted anything. A fetcher keeps its last
   * answer for as long as it is mounted, and the trigger stays mounted
   * on a record's page all day — without this, opening the dialog a
   * second time would greet the reader with the first add's
   * confirmation.
   */
  const [posted, setPosted] = useState(false);

  // Two fetchers, because the list and the add are two conversations:
  // a failed add must not blank the list it was chosen from.
  const targets = useFetcher<TargetsResponse>();
  const add = useFetcher<AddResponse>();

  const openDialog = () => {
    setOpen(true);
    setChoice(null);
    setName("");
    setPosted(false);
    // The list is asked for every time the dialog opens: a handlist
    // made in another tab five minutes ago belongs in it.
    const data = new FormData();
    data.set("_action", "targets");
    data.set("recordType", recordType);
    // The members go with the question so the answer can say which
    // handlists already hold them. A caller still resolving its
    // members asks without them and gets plain counts.
    if (memberIds !== null) data.set("memberIds", JSON.stringify(memberIds));
    void targets.submit(data, { method: "post", action: ADD_ROUTE });
    onOpen?.();
  };

  const closeDialog = () => {
    setOpen(false);
    setChoice(null);
    setName("");
    setPosted(false);
  };

  const answer = posted && add.state === "idle" ? add.data : undefined;
  const result = answer?.ok ? answer : null;
  const failure = answer && !answer.ok ? answer.error : null;
  const rows: HandlistTarget[] =
    targets.data?.ok === true ? targets.data.targets : [];
  const listPending = targets.state !== "idle" && !targets.data;
  /** Nothing to add until the caller says what the members are. */
  const membersReady = memberIds !== null && resolveError === null;
  const nameRequired = choice === "new";
  const canConfirm =
    membersReady &&
    add.state === "idle" &&
    result === null &&
    choice !== null &&
    (!nameRequired || name.trim().length > 0);

  const confirm = () => {
    if (!canConfirm || memberIds === null || choice === null) return;
    const data = new FormData();
    data.set("recordType", recordType);
    data.set("memberIds", JSON.stringify(memberIds));
    if (choice === "new") data.set("newName", name.trim());
    else data.set("handlistId", choice);
    setPosted(true);
    void add.submit(data, { method: "post", action: ADD_ROUTE });
  };

  // The outcome is handed up on the way out, so a caller that wants to
  // clear its selection or show its own confirmation can.
  const finish = () => {
    if (result) {
      onDone?.({
        id: result.id,
        name: result.name,
        added: result.added,
        alreadyIn: result.alreadyIn,
        total: result.total,
      });
    }
    closeDialog();
  };

  return (
    <>
      {/* A record already in a handlist wears the verdigris it wears
          everywhere else, and the trigger states the membership rather
          than only offering the action. The action is still the
          button's errand — a record can join a second handlist. */}
      <button
        type="button"
        onClick={openDialog}
        className={
          triggerClassName ??
          (holdingCount > 0
            ? "inline-flex items-center gap-2 rounded-md border border-verdigris-soft bg-verdigris-wash px-4 py-2 text-sm font-semibold text-verdigris-deep hover:bg-verdigris-tint"
            : "inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50")
        }
      >
        {holdingCount > 0 ? (
          <ListChecks className="h-4 w-4" strokeWidth={1.75} />
        ) : (
          <ListPlus className="h-4 w-4" strokeWidth={1.75} />
        )}
        {holdingCount > 0
          ? t("inHandlists", { count: holdingCount })
          : triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="handlist-picker-title"
        >
          <div className="w-full max-w-[27rem] rounded-lg border border-stone-200 bg-white p-6 shadow-lg">
            <p
              id="handlist-picker-title"
              className="font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
            >
              {t(intent === "save" ? "pickerSaveTitle" : "pickerAddTitle")}
            </p>

            {/* The confirmation: the resulting count, and the duplicates
                it did not add twice. Never a bare "Added". */}
            {result ? (
              <div className="mt-4 rounded-md border border-verdigris-soft bg-verdigris-wash px-3 py-2.5">
                <p className="flex items-start gap-2 text-13 font-medium leading-normal text-verdigris-deep">
                  <Check
                    className="mt-0.5 h-4 w-4 shrink-0"
                    strokeWidth={1.75}
                  />
                  <span>
                    {t("pickerResult", {
                      count: result.total,
                      name: result.name,
                    })}
                  </span>
                </p>
                {result.alreadyIn > 0 && (
                  <p className="mt-1 pl-6 text-13 leading-normal text-verdigris-deep">
                    {t("pickerAlreadyIn", { count: result.alreadyIn })}
                  </p>
                )}
                {result.warn && (
                  <p className="mt-1 pl-6 text-13 leading-normal text-saffron-deep">
                    {t("warnCeiling", { count: result.total })}
                  </p>
                )}
              </div>
            ) : resolveError ? (
              <p className="mt-4 rounded-md border border-madder-tint bg-madder-wash px-3 py-2.5 text-13 leading-normal text-stone-600">
                {resolveError}
              </p>
            ) : (
              <>
                {failure && (
                  <p className="mt-4 rounded-md border border-madder-tint bg-madder-wash px-3 py-2.5 text-13 leading-normal text-stone-600">
                    {ERROR_KEYS[failure]
                      ? t(ERROR_KEYS[failure])
                      : t("error.generic_detail", { ns: "common" })}
                  </p>
                )}

                <div className="mt-4 max-h-64 overflow-y-auto rounded-lg border border-stone-200">
                  {listPending ? (
                    <p className="px-3 py-3 text-13 text-stone-500">
                      {t("label.loading", { ns: "common" })}
                    </p>
                  ) : rows.length === 0 ? (
                    <p className="px-3 py-3 text-13 text-stone-500">
                      {t("pickerEmpty")}
                    </p>
                  ) : (
                    <ul>
                      {rows.map((row) => (
                        <li key={row.id}>
                          <label className="flex cursor-pointer items-center gap-2.5 border-b border-stone-100 px-3 py-2.5 hover:bg-stone-50">
                            <input
                              type="radio"
                              name="handlist-target"
                              checked={choice === row.id}
                              onChange={() => setChoice(row.id)}
                              className="h-3.5 w-3.5 shrink-0 accent-indigo"
                            />
                            <span className="min-w-0 flex-1 break-words text-13 font-semibold text-stone-700">
                              {row.name}
                            </span>
                            {/* Where the members already are, in place
                                of the count: a handlist that holds
                                them says so before the add, not after.
                                Verdigris is the working-set dye the
                                record wears everywhere else. */}
                            {row.alreadyIn > 0 ? (
                              <span className="shrink-0 text-11 font-semibold text-verdigris-deep">
                                {memberIds !== null && memberIds.length === 1
                                  ? t("pickerHoldsThis")
                                  : t("pickerAlreadyIn", {
                                      count: row.alreadyIn,
                                    })}
                              </span>
                            ) : (
                              <span className="font-mono text-11 nums text-stone-400">
                                {formatNumber(row.total)}
                              </span>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Naming is required at creation, so the option opens
                      a field rather than making a handlist on the spot. */}
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 hover:bg-stone-50">
                    <input
                      type="radio"
                      name="handlist-target"
                      checked={choice === "new"}
                      onChange={() => setChoice("new")}
                      className="h-3.5 w-3.5 shrink-0 accent-indigo"
                    />
                    <Plus
                      className="h-3.5 w-3.5 shrink-0 text-indigo"
                      strokeWidth={1.75}
                    />
                    <span className="text-13 font-semibold text-indigo">
                      {t("pickerNewOption")}
                    </span>
                  </label>
                </div>

                {nameRequired && (
                  <div className="mt-3">
                    <label
                      htmlFor="handlist-picker-name"
                      className="block text-sm font-medium text-stone-700"
                    >
                      {t("pickerNameLabel")}
                    </label>
                    <input
                      id="handlist-picker-name"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t("pickerNamePlaceholder")}
                      className="mt-1.5 h-10 w-full rounded-lg border border-stone-300 px-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris"
                    />
                  </div>
                )}

                {/* The members are still being resolved server-side. */}
                {memberIds === null && (
                  <p className="mt-3 text-13 text-stone-500">
                    {t("label.loading", { ns: "common" })}
                  </p>
                )}
              </>
            )}

            <div className="mt-5 flex items-center justify-end gap-2.5">
              {result ? (
                <button
                  type="button"
                  onClick={finish}
                  className="inline-flex h-11 items-center rounded-lg bg-indigo px-4.5 text-15 font-semibold text-parchment hover:bg-indigo-deep"
                >
                  {t("label.close", { ns: "common" })}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
                  >
                    {t("pickerCancel")}
                  </button>
                  <button
                    type="button"
                    disabled={!canConfirm}
                    onClick={confirm}
                    className="inline-flex h-11 items-center rounded-lg bg-indigo px-4.5 text-15 font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {t(nameRequired ? "pickerCreateAndAdd" : "pickerAdd")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
