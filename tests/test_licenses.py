import pytest

from ideation_goat.licenses import classify, conflict
from ideation_goat.manifests import license_from_text


@pytest.mark.parametrize(
    ("expression", "category"),
    [
        ("MIT", "permissive"),
        ("Apache-2.0 OR MIT", "permissive"),
        ("GPL-3.0-only OR MIT", "permissive"),
        ("MIT AND GPL-3.0-or-later", "strong-copyleft"),
        ("GPL-2.0-or-later WITH Classpath-exception-2.0", "strong-copyleft"),
        ("LGPL-2.1-only", "weak-copyleft"),
        ("AGPL-3.0", "network-copyleft"),
        ("non-standard", "unknown"),
        (None, "unknown"),
        ("", "unknown"),
    ],
)
def test_classify(expression: str | None, category: str) -> None:
    assert classify(expression) == category


def test_conflicts() -> None:
    assert conflict("MIT", "GPL-3.0-only") is not None
    assert conflict("MIT", "AGPL-3.0-only") is not None
    assert conflict("MIT", "LGPL-3.0-only") is None
    assert conflict("MIT", "Apache-2.0") is None
    assert conflict("MIT", None) == "no recognised open-source license"
    assert conflict("GPL-3.0-or-later", "GPL-2.0-only") is not None
    assert conflict("GPL-3.0-or-later", "GPL-2.0-or-later") is None
    assert conflict("GPL-3.0-or-later", "LGPL-2.1-only") is None
    assert conflict("GPL-3.0-or-later", "MIT") is None


def test_gpl_text_is_not_detected_as_mit() -> None:
    # The old detector matched "mit" inside "permitted" and called GPL-3.0 MIT.
    gpl = (
        "GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007 ... Everyone is permitted to copy and "
        "distribute verbatim copies of this license document"
    )
    assert license_from_text(gpl) == "GPL-3.0"
    assert license_from_text("GNU LESSER GENERAL PUBLIC LICENSE Version 3") == "LGPL-3.0"
    assert license_from_text("MIT License\n\nPermission is hereby granted, free of charge, to any") == "MIT"
    bsd3 = "Redistribution and use in source and binary forms ... Neither the name of the copyright holder"
    assert license_from_text(bsd3) == "BSD-3-Clause"
    assert license_from_text("All rights reserved.") is None
