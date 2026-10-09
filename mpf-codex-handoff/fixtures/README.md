# Test Fixtures (Public MPF Fund Data)

- `hsbc_all_supertrust_20260901_20261007.csv`: HSBC all-funds CSV downloaded by the user; 20 funds, 26 published price dates, 520 normalized fund-date records.
- `manulife_fundslist.json`: Manulife fund list/latest NAV JSON supplied by the user; 76 records, 31 with product ID 8 and 45 with product ID 22; one special nonstandard NAV/interest-fund record (`DHK121`).

**Missing:** actual `fundhistory?id=SHK122` body. Fetch and save as a fixture before writing/validating historical parsing logic. Do not fabricate it.
