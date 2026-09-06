/**
 * Date-input recognition shared across adapters. Ashby renders its date
 * fields as react-datepicker text inputs (`input.ashby-application-form-
 * input-date`), and the generic `.react-datepicker__input-container input`
 * half matches the same widget wherever the library appears. Lives in
 * shared/ so the Greenhouse-derived filler does not import another
 * vendor's registry (layering rule); the vendor registries reference this
 * constant instead.
 */
export const DATE_INPUT_SELECTOR =
  "input.ashby-application-form-input-date, .react-datepicker__input-container input";
