CLASS zcl_bwmcp_dtp_filter DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES:
      BEGIN OF t_s_selection,
        field    TYPE rsbk_s_select-field,
        sign     TYPE rsbk_s_select-sign,
        option   TYPE rsbk_s_select-option,
        low      TYPE rsbk_s_select-low,
        high     TYPE rsbk_s_select-high,
        sel_type TYPE rsbk_s_select-sel_type,
      END OF t_s_selection .
    TYPES:
      t_t_selection TYPE STANDARD TABLE OF t_s_selection WITH DEFAULT KEY .
    TYPES:
      BEGIN OF t_s_dynamic,
        field        TYPE mch_var_select-field,
        sel_routine  TYPE mch_var_select-sel_routine,
        bex_variable TYPE mch_var_select-bex_variable,
        bex_periv    TYPE mch_var_select-bex_periv,
        sel_type     TYPE mch_var_select-sel_type,
      END OF t_s_dynamic .
    TYPES:
      t_t_dynamic TYPE STANDARD TABLE OF t_s_dynamic WITH DEFAULT KEY .
    TYPES:
      BEGIN OF t_s_routine,
        field       TYPE mch_s_sourcecode-field,
        sel_routine TYPE mch_s_sourcecode-sel_routine,
        codeid      TYPE mch_s_sourcecode-codeid,
        objvers     TYPE mch_s_sourcecode-objvers,
        line_count  TYPE i,
        source      TYPE string,
      END OF t_s_routine .
    TYPES:
      t_t_routine TYPE STANDARD TABLE OF t_s_routine WITH DEFAULT KEY .
    TYPES:
      BEGIN OF t_s_field,
        field     TYPE mch_s_field-field,
        iobjnm    TYPE mch_s_field-iobjnm,
        selection TYPE mch_s_field-selection,
        fieldtxt  TYPE mch_s_field-fieldtxt,
      END OF t_s_field .
    TYPES:
      t_t_field TYPE STANDARD TABLE OF t_s_field WITH DEFAULT KEY .
    TYPES:
      BEGIN OF t_s_result,
        dtp             TYPE rsbkdtpnm,
        objvers         TYPE rsobjvers,
        found           TYPE abap_bool,
        message         TYPE string,
        selections      TYPE t_t_selection,
        dynamic         TYPE t_t_dynamic,
        routines        TYPE t_t_routine,
        fields          TYPE t_t_field,
        semantic_groups TYPE rsbk_tx_fields_keyfl,
        max_size        TYPE rsbkmaxsize,
        min_size        TYPE rsbkmimsize,
      END OF t_s_result .

    CLASS-METHODS get_filter
      IMPORTING
        !i_dtp            TYPE rsbkdtpnm
      RETURNING
        VALUE(r_s_result) TYPE t_s_result .
    CLASS-METHODS get_filter_json
      IMPORTING
        !i_dtp        TYPE rsbkdtpnm
      RETURNING
        VALUE(r_json) TYPE string .
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.



CLASS zcl_bwmcp_dtp_filter IMPLEMENTATION.

  METHOD get_filter.

    DATA l_r_dtp       TYPE REF TO cl_rsbk_dtp.
    DATA l_r_vers      TYPE REF TO cl_rsbk_dtp_v.
    DATA l_r_filter    TYPE REF TO cl_rsbc_filter.
    DATA l_t_varseltab TYPE mch_t_var_select.
    DATA l_t_seltab    TYPE mch_t_select.
    DATA l_t_dtprule   TYPE mch_t_sourcecode.
    DATA l_t_selfields TYPE mch_t_field.
    DATA l_s_selection TYPE t_s_selection.
    DATA l_s_dynamic   TYPE t_s_dynamic.
    DATA l_s_field     TYPE t_s_field.
    DATA l_r_exc       TYPE REF TO cx_root.

    FIELD-SYMBOLS <l_s_sel>  TYPE rsbk_s_select.
    FIELD-SYMBOLS <l_s_var>  TYPE mch_var_select.
    FIELD-SYMBOLS <l_s_code> TYPE mch_s_sourcecode.
    FIELD-SYMBOLS <l_s_fld>  TYPE mch_s_field.
    FIELD-SYMBOLS <l_s_rout> TYPE t_s_routine.

    r_s_result-dtp     = i_dtp.
    r_s_result-objvers = 'A'.

*   The active version is asked for explicitly. The facade hands out whatever
*   version it currently holds, which is the modified one for an edited DTP.
    TRY.
        l_r_dtp = cl_rsbk_dtp=>factory( i_dtp ).
        IF l_r_dtp IS INITIAL.
          r_s_result-message = 'DTP not found'.
          RETURN.
        ENDIF.
        l_r_vers = l_r_dtp->get_obj_ref_objvers( i_objvers = 'A' ).
        l_r_filter = l_r_vers->get_obj_ref_filter( ).
      CATCH cx_root INTO l_r_exc.
        r_s_result-message = l_r_exc->get_text( ).
        RETURN.
    ENDTRY.

    IF l_r_filter IS INITIAL.
      r_s_result-message = 'DTP has no filter object'.
      RETURN.
    ENDIF.

    r_s_result-found = abap_true.

*   Semantic group and package sizes sit in the same serialised template as the
*   filter, so they are answered here rather than in a second round trip.
    TRY.
        l_r_vers->get_groupfields( IMPORTING e_t_groupfields = r_s_result-semantic_groups ).
        r_s_result-max_size = l_r_vers->get_maxsize( ).
        r_s_result-min_size = l_r_vers->if_rsbk_dtp_display~get_minsize( ).
      CATCH cx_root.
*       A DTP without groups or sizes is not an error.
    ENDTRY.

    l_r_filter->get_all(
      IMPORTING
        e_t_varseltab = l_t_varseltab
        e_t_seltab    = l_t_seltab
        e_t_dtprule   = l_t_dtprule
        e_t_selfields = l_t_selfields ).

    LOOP AT l_t_seltab ASSIGNING <l_s_sel>.
      CLEAR l_s_selection.
      MOVE-CORRESPONDING <l_s_sel> TO l_s_selection.
      APPEND l_s_selection TO r_s_result-selections.
    ENDLOOP.

    LOOP AT l_t_varseltab ASSIGNING <l_s_var>.
      CLEAR l_s_dynamic.
      MOVE-CORRESPONDING <l_s_var> TO l_s_dynamic.
      APPEND l_s_dynamic TO r_s_result-dynamic.
    ENDLOOP.

    LOOP AT l_t_selfields ASSIGNING <l_s_fld>.
      CLEAR l_s_field.
      MOVE-CORRESPONDING <l_s_fld> TO l_s_field.
      APPEND l_s_field TO r_s_result-fields.
    ENDLOOP.

*   The routine arrives line by line; collapse it into one entry per code id.
*   The entry without a field carries the declaration part of the routine.
    LOOP AT l_t_dtprule ASSIGNING <l_s_code>.
      READ TABLE r_s_result-routines ASSIGNING <l_s_rout>
           WITH KEY codeid = <l_s_code>-codeid
                    field  = <l_s_code>-field.
      IF sy-subrc <> 0.
        APPEND INITIAL LINE TO r_s_result-routines ASSIGNING <l_s_rout>.
        <l_s_rout>-field       = <l_s_code>-field.
        <l_s_rout>-sel_routine = <l_s_code>-sel_routine.
        <l_s_rout>-codeid      = <l_s_code>-codeid.
        <l_s_rout>-objvers     = <l_s_code>-objvers.
      ENDIF.
      IF <l_s_rout>-line_count = 0.
        <l_s_rout>-source = <l_s_code>-line.
      ELSE.
        CONCATENATE <l_s_rout>-source <l_s_code>-line
               INTO <l_s_rout>-source
               SEPARATED BY cl_abap_char_utilities=>newline.
      ENDIF.
      <l_s_rout>-line_count = <l_s_rout>-line_count + 1.
    ENDLOOP.

  ENDMETHOD.

  METHOD get_filter_json.

    DATA l_s_result TYPE t_s_result.

    l_s_result = get_filter( i_dtp ).

    r_json = /ui2/cl_json=>serialize(
               data        = l_s_result
               pretty_name = /ui2/cl_json=>pretty_mode-low_case ).

  ENDMETHOD.

ENDCLASS.
