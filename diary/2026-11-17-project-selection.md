# Shared project selection

Removed the duplicate selected-project label. One shared browser navigation adapter
uses the existing status API to restore a valid origin-local saved project, or
select the sole registered project. Explicit repo parameters retain precedence and
server validation. Storage is optional and failures preserve manual navigation.
Quotas retains project context without changing its account-wide data scope.
Regression cases cover return navigation, invalid explicit selections, removed
projects, multiple/no projects, and disabled browser storage.
